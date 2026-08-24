import { createHash } from "node:crypto"
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path"
import { gunzipSync, inflateRawSync } from "node:zlib"

export type RouterAssetProgress = Readonly<{
  backend: string
  version: string
  phase: "waiting" | "downloading" | "verifying" | "extracting" | "ready"
  transferredBytes?: number
  totalBytes?: number
}>

export type RouterAssetPolicy = Readonly<{
  /** Shared cache root. Defaults to the platform user cache directory. */
  cacheDirectory?: string
  /** Defaults to true. Set false only for deliberately offline deployments. */
  allowDownload?: boolean
  signal?: AbortSignal
  onProgress?: (progress: RouterAssetProgress) => void
}>

export type ManagedRouterAssetSpec = Readonly<{
  backend: string
  version: string
  url: string
  sha256: string
  archive: "zip" | "tar.gz" | "file"
  /** Required for a single-file release asset. */
  fileName?: string
  /** Optional exact release size. A mismatch is rejected before extraction. */
  sizeBytes?: number
  /** Directory inside the archive which is the backend root. */
  rootDirectory?: string
  /** Files which must exist below the resolved backend root. */
  markers: readonly string[]
  /** Backend-specific, deterministic preparation before the cache becomes visible. */
  prepareDirectory?: (directory: string) => Promise<void>
}>

export type PreparedRouterAsset = Readonly<{
  backend: string
  version: string
  directory: string
  source: "override" | "cache" | "download"
  cacheDirectory: string
}>

export class RouterAssetError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = "RouterAssetError"
    this.code = code
    this.details = details
  }
}

const LOCK_STALE_MS = 10 * 60_000
const LOCK_WAIT_MS = 60_000
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_EXTRACTED_ARCHIVE_BYTES = 768 * 1024 * 1024

export function defaultRouterCacheDirectory() {
  if (process.env.COPILOT_ROUTER_CACHE_DIR) return resolve(process.env.COPILOT_ROUTER_CACHE_DIR)
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    return join(base, "eda-copilot", "router")
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "eda-copilot", "router")
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "eda-copilot", "router")
}

async function readable(path: string) {
  return access(path, constants.R_OK).then(() => true, () => false)
}

async function validDirectory(directory: string, markers: readonly string[]) {
  return (await Promise.all(markers.map((marker) => readable(join(directory, marker))))).every(Boolean)
}

async function validManagedInstallation(
  installation: string,
  directory: string,
  spec: ManagedRouterAssetSpec,
) {
  if (!(await validDirectory(directory, spec.markers))) return false
  try {
    const receipt = JSON.parse(await readFile(join(installation, ".copilot-router-asset.json"), "utf8")) as {
      backend?: unknown
      version?: unknown
      url?: unknown
      sha256?: unknown
    }
    return receipt.backend === spec.backend
      && receipt.version === spec.version
      && receipt.url === spec.url
      && typeof receipt.sha256 === "string"
      && receipt.sha256.toLowerCase() === spec.sha256.toLowerCase()
  } catch {
    return false
  }
}

function assertSafeIdentifier(value: string, field: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new RouterAssetError(
    "ROUTER_ASSET_SPEC_INVALID",
    `${field} contains unsupported characters.`,
    { field, value },
  )
}

function emit(
  spec: ManagedRouterAssetSpec,
  policy: RouterAssetPolicy,
  phase: RouterAssetProgress["phase"],
  details: Omit<RouterAssetProgress, "backend" | "version" | "phase"> = {},
) {
  policy.onProgress?.({ backend: spec.backend, version: spec.version, phase, ...details })
}

function abortError() {
  return new RouterAssetError("ROUTER_ASSET_ABORTED", "Router backend preparation was aborted.")
}

async function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
  await new Promise<void>((resolvePromise, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort)
      resolvePromise()
    }
    const timer = setTimeout(finish, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(abortError())
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

async function acquireLock(path: string, policy: RouterAssetPolicy, spec: ManagedRouterAssetSpec) {
  const started = Date.now()
  while (true) {
    if (policy.signal?.aborted) throw abortError()
    try {
      await mkdir(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const age = await stat(path).then((value) => Date.now() - value.mtimeMs, () => 0)
    if (age > LOCK_STALE_MS) {
      await rm(path, { recursive: true, force: true })
      continue
    }
    if (Date.now() - started > LOCK_WAIT_MS) throw new RouterAssetError(
      "ROUTER_ASSET_LOCK_TIMEOUT",
      `Timed out waiting for another ${spec.backend} installation.`,
      { lock: path },
    )
    emit(spec, policy, "waiting")
    await delay(100, policy.signal)
  }
}

function safeArchivePath(name: string) {
  const normalized = posix.normalize(name.replaceAll("\\", "/"))
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")
    || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || isAbsolute(normalized)) {
    throw new RouterAssetError("ROUTER_ASSET_ARCHIVE_UNSAFE", "Archive contains an unsafe path.", { name })
  }
  return normalized
}

function findEndOfCentralDirectory(buffer: Buffer) {
  const minimum = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new RouterAssetError("ROUTER_ASSET_ARCHIVE_INVALID", "ZIP central directory was not found.")
}

async function extractZip(buffer: Buffer, output: string) {
  const eocd = findEndOfCentralDirectory(buffer)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  await mkdir(output, { recursive: true })
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new RouterAssetError(
      "ROUTER_ASSET_ARCHIVE_INVALID", "ZIP central directory entry is invalid.", { index },
    )
    const flags = buffer.readUInt16LE(cursor + 8)
    const compression = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) throw new RouterAssetError(
      "ROUTER_ASSET_ARCHIVE_UNSUPPORTED", "ZIP64 backend archives are not supported.",
    )
    if (flags & 1) throw new RouterAssetError(
      "ROUTER_ASSET_ARCHIVE_UNSUPPORTED", "Encrypted backend archives are not supported.",
    )
    const name = safeArchivePath(buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength))
    const unixType = (externalAttributes >>> 16) & 0xf000
    if (unixType === 0xa000) throw new RouterAssetError(
      "ROUTER_ASSET_ARCHIVE_UNSAFE", "Backend archives may not contain symbolic links.", { name },
    )
    const target = join(output, ...name.split("/"))
    const directory = name.endsWith("/") || unixType === 0x4000
    if (directory) await mkdir(target, { recursive: true })
    else {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new RouterAssetError(
        "ROUTER_ASSET_ARCHIVE_INVALID", "ZIP local entry is invalid.", { name },
      )
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength
      const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
      let contents: Buffer
      if (compression === 0) contents = Buffer.from(compressed)
      else if (compression === 8) contents = inflateRawSync(compressed)
      else throw new RouterAssetError(
        "ROUTER_ASSET_ARCHIVE_UNSUPPORTED", `ZIP compression method ${compression} is unsupported.`, { name },
      )
      if (contents.length !== uncompressedSize) throw new RouterAssetError(
        "ROUTER_ASSET_ARCHIVE_INVALID", "ZIP entry size does not match its central directory.", { name },
      )
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents)
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
}

function tarString(buffer: Buffer, start: number, length: number) {
  const end = buffer.indexOf(0, start)
  return buffer.toString("utf8", start, end < 0 || end > start + length ? start + length : end)
}

function tarNumber(buffer: Buffer, start: number, length: number) {
  const value = tarString(buffer, start, length).trim()
  if (!value) return 0
  if (!/^[0-7]+$/.test(value)) throw new RouterAssetError(
    "ROUTER_ASSET_ARCHIVE_INVALID", "TAR header contains an invalid numeric field.", { value },
  )
  return Number.parseInt(value, 8)
}

function parsePax(contents: Buffer) {
  const values: Record<string, string> = {}
  let cursor = 0
  while (cursor < contents.length) {
    const separator = contents.indexOf(0x20, cursor)
    if (separator < 0) throw new RouterAssetError(
      "ROUTER_ASSET_ARCHIVE_INVALID", "TAR PAX record has no length separator.",
    )
    const length = Number.parseInt(contents.toString("ascii", cursor, separator), 10)
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > contents.length) throw new RouterAssetError(
      "ROUTER_ASSET_ARCHIVE_INVALID", "TAR PAX record has an invalid length.", { length },
    )
    const record = contents.toString("utf8", separator + 1, cursor + length - 1)
    const equals = record.indexOf("=")
    if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1)
    cursor += length
  }
  return values
}

function safeArchiveLink(output: string, target: string, linkName: string, rootRelative = false) {
  if (!linkName || posix.isAbsolute(linkName) || /^[A-Za-z]:/.test(linkName)) throw new RouterAssetError(
    "ROUTER_ASSET_ARCHIVE_UNSAFE", "Archive contains an unsafe link target.", { linkName },
  )
  const resolved = resolve(rootRelative ? output : dirname(target), ...linkName.replaceAll("\\", "/").split("/"))
  const root = resolve(output)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new RouterAssetError(
    "ROUTER_ASSET_ARCHIVE_UNSAFE", "Archive link escapes the extraction directory.", { linkName },
  )
  return resolved
}

async function extractTarGz(buffer: Buffer, output: string) {
  let archive: Buffer
  try {
    archive = gunzipSync(buffer, { maxOutputLength: MAX_EXTRACTED_ARCHIVE_BYTES })
  } catch (error) {
    throw new RouterAssetError(
      "ROUTER_ASSET_ARCHIVE_INVALID", "Could not decompress the TAR.GZ backend archive.",
      { error: error instanceof Error ? error.message : String(error) },
    )
  }
  await mkdir(output, { recursive: true })
  let cursor = 0
  let pax: Record<string, string> = {}
  let globalPax: Record<string, string> = {}
  let longName: string | undefined
  let longLink: string | undefined
  const deferredLinks: Array<{ target: string; linkName: string; symbolic: boolean }> = []
  while (cursor + 512 <= archive.length) {
    const header = archive.subarray(cursor, cursor + 512)
    if (header.every((value) => value === 0)) break
    const storedChecksum = tarNumber(header, 148, 8)
    const checksumHeader = Buffer.from(header)
    checksumHeader.fill(0x20, 148, 156)
    const actualChecksum = checksumHeader.reduce((sum, value) => sum + value, 0)
    if (storedChecksum !== actualChecksum) throw new RouterAssetError(
      "ROUTER_ASSET_ARCHIVE_INVALID", "TAR header checksum does not match.", { cursor },
    )
    const size = tarNumber(header, 124, 12)
    const mode = tarNumber(header, 100, 8)
    const type = String.fromCharCode(header[156] || 0x30)
    const prefix = tarString(header, 345, 155)
    const headerName = [prefix, tarString(header, 0, 100)].filter(Boolean).join("/")
    const contentsStart = cursor + 512
    const contentsEnd = contentsStart + size
    if (!Number.isSafeInteger(size) || contentsEnd > archive.length) throw new RouterAssetError(
      "ROUTER_ASSET_ARCHIVE_INVALID", "TAR entry extends past the end of the archive.", { headerName, size },
    )
    const contents = archive.subarray(contentsStart, contentsEnd)
    cursor = contentsStart + Math.ceil(size / 512) * 512
    if (type === "x" || type === "g") {
      const values = parsePax(contents)
      if (type === "g") globalPax = { ...globalPax, ...values }
      else pax = values
      continue
    }
    if (type === "L" || type === "K") {
      const value = contents.toString("utf8").replace(/\0.*$/s, "").replace(/\n$/, "")
      if (type === "L") longName = value
      else longLink = value
      continue
    }
    const metadata = { ...globalPax, ...pax }
    const name = safeArchivePath(metadata.path ?? longName ?? headerName)
    const target = join(output, ...name.split("/"))
    const linkName = metadata.linkpath ?? longLink ?? tarString(header, 157, 100)
    pax = {}
    longName = undefined
    longLink = undefined
    if (type === "5") await mkdir(target, { recursive: true })
    else if (type === "0" || type === "\0" || type === "7") {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents)
      if (process.platform !== "win32" && mode) await chmod(target, mode & 0o777)
    } else if (type === "1" || type === "2") {
      safeArchiveLink(output, target, linkName, type === "1")
      deferredLinks.push({ target, linkName, symbolic: type === "2" })
    } else throw new RouterAssetError(
      "ROUTER_ASSET_ARCHIVE_UNSUPPORTED", `TAR entry type ${JSON.stringify(type)} is unsupported.`, { name },
    )
  }
  for (const item of deferredLinks) {
    await mkdir(dirname(item.target), { recursive: true })
    const source = safeArchiveLink(output, item.target, item.linkName, !item.symbolic)
    if (item.symbolic) {
      const portableTarget = relative(dirname(item.target), source) || "."
      await symlink(portableTarget, item.target).catch(async (error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code ?? "")) throw error
        await copyFile(source, item.target)
      })
    } else await link(source, item.target).catch(async () => copyFile(source, item.target))
  }
}

async function download(spec: ManagedRouterAssetSpec, policy: RouterAssetPolicy) {
  if (policy.signal?.aborted) throw abortError()
  const response = await fetch(spec.url, { redirect: "follow", signal: policy.signal })
  if (!response.ok || !response.body) throw new RouterAssetError(
    "ROUTER_ASSET_DOWNLOAD_FAILED",
    `Could not download ${spec.backend} ${spec.version} (${response.status} ${response.statusText}).`,
    { url: spec.url, status: response.status },
  )
  const headerSize = Number(response.headers.get("content-length"))
  const expectedSize = spec.sizeBytes ?? (Number.isFinite(headerSize) ? headerSize : undefined)
  if (expectedSize !== undefined && expectedSize > MAX_ARCHIVE_BYTES) throw new RouterAssetError(
    "ROUTER_ASSET_TOO_LARGE", "Router backend archive exceeds the safety limit.", { expectedSize },
  )
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let transferred = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    transferred += value.byteLength
    if (transferred > MAX_ARCHIVE_BYTES) throw new RouterAssetError(
      "ROUTER_ASSET_TOO_LARGE", "Router backend archive exceeds the safety limit.", { transferred },
    )
    chunks.push(Buffer.from(value))
    emit(spec, policy, "downloading", { transferredBytes: transferred, totalBytes: expectedSize })
  }
  if (spec.sizeBytes !== undefined && transferred !== spec.sizeBytes) throw new RouterAssetError(
    "ROUTER_ASSET_SIZE_MISMATCH",
    `Downloaded ${spec.backend} archive has an unexpected size.`,
    { expected: spec.sizeBytes, actual: transferred },
  )
  return Buffer.concat(chunks)
}

/**
 * Prepare a pinned backend release without requiring a manual installation.
 * The archive is verified before extraction and the cache is published atomically.
 */
export async function prepareManagedRouterAsset(
  spec: ManagedRouterAssetSpec,
  policy: RouterAssetPolicy = {},
  overrideDirectory?: string,
): Promise<PreparedRouterAsset> {
  assertSafeIdentifier(spec.backend, "backend")
  assertSafeIdentifier(spec.version, "version")
  if (!/^[a-f0-9]{64}$/i.test(spec.sha256)) throw new RouterAssetError(
    "ROUTER_ASSET_SPEC_INVALID", "Router asset SHA-256 must contain 64 hexadecimal characters.",
  )
  if (!spec.markers.length) throw new RouterAssetError(
    "ROUTER_ASSET_SPEC_INVALID", "Router asset must declare at least one integrity marker.",
  )
  const cacheDirectory = resolve(policy.cacheDirectory ?? defaultRouterCacheDirectory())
  if (overrideDirectory) {
    const directory = resolve(overrideDirectory)
    if (!(await validDirectory(directory, spec.markers))) throw new RouterAssetError(
      "ROUTER_ASSET_OVERRIDE_INVALID",
      `${spec.backend} override does not contain the required backend files.`,
      { directory, markers: spec.markers },
    )
    return { backend: spec.backend, version: spec.version, directory, source: "override", cacheDirectory }
  }
  const installation = join(cacheDirectory, "backends", spec.backend, spec.version)
  const directory = spec.rootDirectory ? join(installation, spec.rootDirectory) : installation
  if (await validManagedInstallation(installation, directory, spec)) {
    emit(spec, policy, "ready")
    return { backend: spec.backend, version: spec.version, directory, source: "cache", cacheDirectory }
  }
  if (policy.allowDownload === false) throw new RouterAssetError(
    "ROUTER_ASSET_NOT_CACHED",
    `${spec.backend} ${spec.version} is not cached and downloads are disabled.`,
    { cacheDirectory },
  )

  const lock = `${installation}.lock`
  await mkdir(dirname(installation), { recursive: true })
  await acquireLock(lock, policy, spec)
  let temporary: string | undefined
  try {
    if (await validManagedInstallation(installation, directory, spec)) {
      emit(spec, policy, "ready")
      return { backend: spec.backend, version: spec.version, directory, source: "cache", cacheDirectory }
    }
    const archive = await download(spec, policy)
    emit(spec, policy, "verifying", { transferredBytes: archive.length, totalBytes: spec.sizeBytes })
    const actualHash = createHash("sha256").update(archive).digest("hex")
    if (actualHash.toLowerCase() !== spec.sha256.toLowerCase()) throw new RouterAssetError(
      "ROUTER_ASSET_INTEGRITY_FAILED",
      `${spec.backend} archive failed SHA-256 verification.`,
      { expected: spec.sha256, actual: actualHash, url: spec.url },
    )
    temporary = await mkdtemp(join(dirname(installation), `.${spec.version}-install-`))
    emit(spec, policy, "extracting")
    if (spec.archive === "zip") await extractZip(archive, temporary)
    else if (spec.archive === "tar.gz") await extractTarGz(archive, temporary)
    else {
      if (!spec.fileName) throw new RouterAssetError(
        "ROUTER_ASSET_SPEC_INVALID", "Single-file backend assets require fileName.",
      )
      const fileName = safeArchivePath(spec.fileName)
      await mkdir(dirname(join(temporary, fileName)), { recursive: true })
      await writeFile(join(temporary, fileName), archive)
    }
    const preparedDirectory = spec.rootDirectory ? join(temporary, spec.rootDirectory) : temporary
    await spec.prepareDirectory?.(preparedDirectory)
    if (!(await validDirectory(preparedDirectory, spec.markers))) throw new RouterAssetError(
      "ROUTER_ASSET_CONTENT_INVALID",
      `${spec.backend} archive does not contain the required backend files.`,
      { markers: spec.markers },
    )
    await writeFile(join(temporary, ".copilot-router-asset.json"), `${JSON.stringify({
      backend: spec.backend,
      version: spec.version,
      url: spec.url,
      sha256: spec.sha256,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8")
    await rm(installation, { recursive: true, force: true })
    await rename(temporary, installation)
    temporary = undefined
    emit(spec, policy, "ready")
    return { backend: spec.backend, version: spec.version, directory, source: "download", cacheDirectory }
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    await rm(lock, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Read the immutable install receipt for diagnostics and support tooling. */
export async function readRouterAssetReceipt(directory: string) {
  let receipt = join(directory, ".copilot-router-asset.json")
  if (!(await readable(receipt))) receipt = join(dirname(directory), ".copilot-router-asset.json")
  const source = await readFile(receipt, "utf8")
  return JSON.parse(source) as Readonly<Record<string, unknown>>
}

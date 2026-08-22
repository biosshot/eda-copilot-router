import { createHash } from "node:crypto"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, posix, resolve } from "node:path"
import { inflateRawSync } from "node:zlib"

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
  archive: "zip" | "file"
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

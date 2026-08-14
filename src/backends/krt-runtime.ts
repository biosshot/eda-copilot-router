import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { constants } from "node:fs"
import { arch, platform } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  prepareManagedRouterAsset,
  RouterAssetError,
  type PreparedRouterAsset,
  type RouterAssetPolicy,
} from "./assets.js"

export const KRT_MANAGED_VERSION = "0.20.2"

const KRT_RELEASE = Object.freeze({
  backend: "krt",
  version: KRT_MANAGED_VERSION,
  url: "https://github.com/drandyhaas/KiCadRoutingTools/releases/download/v0.20.2/KiCadRoutingTools-0.20.2.zip",
  sha256: "f314ffc3ac2cbe90a0a559cb8d1adff12b9e136406c18e1e29100536f869efac",
  sizeBytes: 5_838_700,
  archive: "zip" as const,
  rootDirectory: "plugins",
  markers: ["py_router/route.py", "py_router/route_diff.py", "requirements.txt", "LICENSE"],
})

export type KrtRuntimeOptions = Readonly<{
  /** Optional local development override. End users do not need this. */
  krtDirectory?: string
  /** Optional Python override. Otherwise a compatible interpreter is discovered. */
  pythonPath?: string
  assets?: RouterAssetPolicy
}>

export type PreparedKrtRuntime = Readonly<{
  directory: string
  pythonPath: string
  pythonPathEntries: readonly string[]
  version: string
  source: PreparedRouterAsset["source"]
  cacheDirectory: string
}>

type ProcessResult = Readonly<{
  exitCode: number | null
  stdout: string
  stderr: string
  error?: string
}>

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function readable(path: string | undefined) {
  if (!path) return false
  return access(path, constants.R_OK).then(() => true, () => false)
}

async function validKrtDirectory(path: string | undefined) {
  if (!path) return false
  return await readable(join(path, "py_router", "route.py"))
    && await readable(join(path, "py_router", "route_diff.py"))
}

async function packagedPatchDirectory() {
  const candidates = [
    fileURLToPath(new URL("../assets/krt-patches/", import.meta.url)),
    fileURLToPath(new URL("../../assets/krt-patches/", import.meta.url)),
  ]
  try {
    const require = createRequire(import.meta.url)
    candidates.unshift(join(dirname(require.resolve("@easyeda-copilot/router/package.json")), "assets", "krt-patches"))
  } catch {
    // Source-tree and standalone package candidates above remain authoritative.
  }
  for (const candidate of candidates) {
    if (await readable(join(candidate, "copilot_router_krt_patch.py"))) return candidate
  }
  throw new RouterAssetError(
    "KRT_PATCH_MISSING",
    "The packaged KRT filled-zone obstacle patch is missing.",
    { candidates },
  )
}

/** Resolve only optional developer overrides. Managed installation is separate. */
export async function discoverKrtOverride(explicit?: string) {
  const declared = [
    explicit,
    process.env.COPILOT_ROUTER_KRT_DIR,
    process.env.KICAD_ROUTING_TOOLS_DIR,
  ].filter((value): value is string => Boolean(value))
  for (const value of declared) {
    const candidate = resolve(value)
    if (await validKrtDirectory(candidate)) return candidate
    throw new RouterAssetError(
      "KRT_OVERRIDE_INVALID",
      "The configured KRT development override does not contain py_router/route.py and route_diff.py.",
      { directory: candidate },
    )
  }
  const candidates = [
    join(process.cwd(), "KiCadRoutingTools"),
    join(process.cwd(), "vendor", "KiCadRoutingTools"),
  ]
  for (const value of candidates) {
    const candidate = resolve(value)
    if (await validKrtDirectory(candidate)) return candidate
  }
  return undefined
}

function platformBinary() {
  const currentPlatform = platform()
  const currentArch = arch()
  if (currentPlatform === "win32" && currentArch === "x64") {
    return { releaseName: "grid_router-windows-x86_64.pyd", importName: "grid_router.pyd" }
  }
  if (currentPlatform === "linux" && currentArch === "x64") {
    return { releaseName: "grid_router-linux-x86_64.so", importName: "grid_router.so" }
  }
  if (currentPlatform === "darwin" && currentArch === "arm64") {
    return { releaseName: "grid_router-macos-arm64.so", importName: "grid_router.so" }
  }
  if (currentPlatform === "darwin" && currentArch === "x64") {
    return { releaseName: "grid_router-macos-x86_64.so", importName: "grid_router.so" }
  }
  throw new RouterAssetError(
    "KRT_PLATFORM_UNSUPPORTED",
    `KRT ${KRT_MANAGED_VERSION} has no prebuilt router for ${currentPlatform}/${currentArch}.`,
    { platform: currentPlatform, arch: currentArch },
  )
}

async function prepareReleaseDirectory(directory: string) {
  const binary = platformBinary()
  const source = join(directory, "rust_router", binary.releaseName)
  if (!(await readable(source))) throw new RouterAssetError(
    "KRT_RELEASE_BINARY_MISSING",
    `The official KRT archive does not contain ${binary.releaseName}.`,
  )
  await copyFile(source, join(directory, "rust_router", binary.importName))
}

function commandCandidates(explicit?: string) {
  const values: string[] = []
  const append = (value: string | undefined) => {
    if (value && !values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value)
  }
  append(explicit)
  append(process.env.COPILOT_ROUTER_PYTHON)
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA
    const programs = process.env.ProgramFiles
    for (const version of ["10.0", "9.0"]) {
      if (local) append(join(local, "Programs", "KiCad", version, "bin", "python.exe"))
      if (programs) append(join(programs, "KiCad", version, "bin", "python.exe"))
    }
  }
  append("python3")
  append("python")
  return values
}

function runProcess(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    let stdout = ""
    let stderr = ""
    let processError: string | undefined
    let settled = false
    const child = spawn(executable, [...args], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...environment },
    })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    child.stderr.on("data", (chunk: string) => { stderr += chunk })
    child.on("error", (error) => { processError = errorText(error) })
    const abort = () => child.kill("SIGKILL")
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      resolvePromise({ exitCode, stdout, stderr, ...(processError ? { error: processError } : {}) })
    }
    child.on("close", finish)
    if (signal?.aborted) abort()
    else signal?.addEventListener("abort", abort, { once: true })
  })
}

async function pythonDetails(command: string, signal?: AbortSignal) {
  const result = await runProcess(command, [
    "-c",
    "import json,sys; print(json.dumps({'version':list(sys.version_info[:3]),'tag':sys.implementation.cache_tag}))",
  ], {}, signal)
  if (result.exitCode !== 0 || result.error) return undefined
  try {
    const details = JSON.parse(result.stdout.trim()) as { version: number[]; tag: string }
    if (details.version[0] !== 3 || details.version[1] < 9 || !details.tag) return undefined
    return details
  } catch {
    return undefined
  }
}

async function discoverPython(explicit?: string, signal?: AbortSignal) {
  for (const candidate of commandCandidates(explicit)) {
    const details = await pythonDetails(candidate, signal)
    if (details) return { command: candidate, details }
  }
  throw new RouterAssetError(
    "KRT_PYTHON_NOT_FOUND",
    "KRT needs Python 3.9 or newer, but no compatible interpreter was found.",
  )
}

function pythonEnvironment(entries: readonly string[]): Record<string, string> {
  const inherited = process.env.PYTHONPATH
  return entries.length || inherited
    ? { PYTHONPATH: [...entries, ...(inherited ? [inherited] : [])].join(delimiter) }
    : {}
}

async function probeKrtPython(
  pythonPath: string,
  krtDirectory: string,
  dependencies: readonly string[],
  signal?: AbortSignal,
) {
  const entries = [...dependencies, join(krtDirectory, "rust_router")]
  return runProcess(
    pythonPath,
    [
      "-c",
      `import sys; sys.path[:0]=${JSON.stringify(entries)}; import numpy,scipy,shapely,grid_router; print('ok')`,
    ],
    pythonEnvironment([]),
    signal,
  )
}

async function preparePythonDependencies(
  asset: PreparedRouterAsset,
  pythonPath: string,
  pythonTag: string,
  policy: RouterAssetPolicy,
) {
  const direct = await probeKrtPython(pythonPath, asset.directory, [], policy.signal)
  if (direct.exitCode === 0 && !direct.error) return []
  const parent = join(asset.cacheDirectory, "runtimes", "krt", KRT_MANAGED_VERSION)
  const target = join(parent, `${pythonTag}-${platform()}-${arch()}`)
  const marker = join(target, ".copilot-router-python.json")
  if (await readable(marker)) {
    const cached = await probeKrtPython(pythonPath, asset.directory, [target], policy.signal)
    if (cached.exitCode === 0 && !cached.error) return [target]
  }
  if (policy.allowDownload === false) throw new RouterAssetError(
    "KRT_PYTHON_DEPENDENCIES_MISSING",
    "KRT Python dependencies are unavailable and managed downloads are disabled.",
    { stderr: direct.stderr.trim(), cacheDirectory: target },
  )

  await mkdir(parent, { recursive: true })
  const temporary = await mkdtemp(join(parent, ".python-install-"))
  try {
    policy.onProgress?.({ backend: "krt", version: KRT_MANAGED_VERSION, phase: "downloading" })
    const installed = await runProcess(pythonPath, [
      "-m", "pip", "install",
      "--disable-pip-version-check",
      "--no-input",
      "--target", temporary,
      "numpy>=1.21.0",
      "scipy>=1.7.0",
      "shapely>=1.8.0",
    ], {}, policy.signal)
    if (installed.exitCode !== 0 || installed.error) throw new RouterAssetError(
      "KRT_PYTHON_DEPENDENCY_INSTALL_FAILED",
      "Could not prepare KRT Python dependencies in the managed cache.",
      { stderr: installed.stderr.trim(), error: installed.error },
    )
    const probe = await probeKrtPython(pythonPath, asset.directory, [temporary], policy.signal)
    if (probe.exitCode !== 0 || probe.error) throw new RouterAssetError(
      "KRT_PYTHON_DEPENDENCY_INVALID",
      "Managed KRT Python dependencies failed their import check.",
      { stderr: probe.stderr.trim(), error: probe.error },
    )
    await writeFile(join(temporary, ".copilot-router-python.json"), `${JSON.stringify({
      backend: "krt",
      backendVersion: KRT_MANAGED_VERSION,
      pythonTag,
      requirements: ["numpy>=1.21.0", "scipy>=1.7.0", "shapely>=1.8.0"],
    }, null, 2)}\n`, "utf8")
    await rm(target, { recursive: true, force: true })
    await rename(temporary, target)
    return [target]
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Resolve KRT as a managed backend. With no override, first use downloads the
 * pinned official release and later runs are fully offline from the user cache.
 */
export async function prepareKrtRuntime(options: KrtRuntimeOptions = {}): Promise<PreparedKrtRuntime> {
  const override = await discoverKrtOverride(options.krtDirectory)
  const asset = await prepareManagedRouterAsset({
    ...KRT_RELEASE,
    prepareDirectory: prepareReleaseDirectory,
  }, options.assets, override)
  const python = await discoverPython(options.pythonPath, options.assets?.signal)
  const dependencyEntries = await preparePythonDependencies(
    asset,
    python.command,
    python.details.tag,
    options.assets ?? {},
  )
  const patchDirectory = await packagedPatchDirectory()
  const pythonPathEntries = [patchDirectory, ...dependencyEntries]
  const finalProbe = await probeKrtPython(
    python.command,
    asset.directory,
    pythonPathEntries,
    options.assets?.signal,
  )
  if (finalProbe.exitCode !== 0 || finalProbe.error) throw new RouterAssetError(
    "KRT_RUNTIME_INVALID",
    "The managed KRT runtime failed its final import check.",
    { stderr: finalProbe.stderr.trim(), error: finalProbe.error, directory: asset.directory },
  )
  return {
    directory: asset.directory,
    pythonPath: python.command,
    pythonPathEntries,
    version: KRT_MANAGED_VERSION,
    source: asset.source,
    cacheDirectory: asset.cacheDirectory,
  }
}

/** Support tooling can inspect the pinned release without triggering a download. */
export function krtManagedRelease() {
  return { ...KRT_RELEASE }
}

/** Read the upstream release license from an already prepared runtime. */
export async function readKrtLicense(runtime: PreparedKrtRuntime) {
  return readFile(join(runtime.directory, "LICENSE"), "utf8")
}

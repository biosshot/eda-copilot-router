import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
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

export const KRT_MANAGED_VERSION = "0.20.4"
export const MANAGED_PYTHON_VERSION = "3.12.14-20260814"

const MANAGED_PYTHON_RELEASE = "20260814"
const MANAGED_PYTHON_ASSETS = Object.freeze({
  "win32-x64": {
    target: "x86_64-pc-windows-msvc",
    sha256: "89f18f6932917163b74339ebcec2645c8e47ae7f1c5f2ac37f2b4f4cf3beb647",
    executable: "python.exe",
  },
  "linux-x64": {
    target: "x86_64-unknown-linux-gnu",
    sha256: "5acfa3e9ba26b51ae161c83aff278da915b590d22373a424b2ba55b8afe91fcc",
    executable: "bin/python3",
  },
  "darwin-x64": {
    target: "x86_64-apple-darwin",
    sha256: "aec265e3cddaccdb2a3d783331596351b24d4a63c97af0a38f75f643c9451de9",
    executable: "bin/python3",
  },
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    sha256: "dd5b76ab11451a4a4367c17c61d944dded56b425396b07f102922a7ebef7d55f",
    executable: "bin/python3",
  },
})

const KRT_RELEASE = Object.freeze({
  backend: "krt",
  version: KRT_MANAGED_VERSION,
  url: "https://github.com/drandyhaas/KiCadRoutingTools/releases/download/v0.20.4/KiCadRoutingTools-0.20.4.zip",
  sha256: "a989af2fa719c3b8d0763cae73dc0be5738a4c3e73c64741a7baaf0c4730c60c",
  sizeBytes: 5_924_458,
  archive: "zip" as const,
  rootDirectory: "plugins",
  markers: ["py_router/route.py", "py_router/route_diff.py", "py_router/qfn_fanout.py", "requirements.txt", "LICENSE"],
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
  pythonSource: "system" | PreparedRouterAsset["source"]
  cacheDirectory: string
}>

type PythonDetails = Readonly<{
  version: number[]
  tag: string
  hasPip: boolean
}>

type PreparedPython = Readonly<{
  command: string
  details: PythonDetails
  source: "system" | PreparedRouterAsset["source"]
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
    && await readable(join(path, "py_router", "qfn_fanout.py"))
}

async function packagedPatchDirectory() {
  const candidates = [
    fileURLToPath(new URL("../assets/krt-patches/", import.meta.url)),
    fileURLToPath(new URL("../../assets/krt-patches/", import.meta.url)),
  ]
  try {
    const require = createRequire(import.meta.url)
    candidates.unshift(join(dirname(require.resolve("eda-copilot-router/package.json")), "assets", "krt-patches"))
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
      "The configured KRT development override does not contain route.py, route_diff.py, and qfn_fanout.py.",
      { directory: candidate },
    )
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
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONNOUSERSITE: "1",
        ...environment,
      },
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
    "import importlib.util,json,sys; print(json.dumps({'version':list(sys.version_info[:3]),'tag':sys.implementation.cache_tag,'hasPip':importlib.util.find_spec('pip') is not None}))",
  ], {}, signal)
  if (result.exitCode !== 0 || result.error) return undefined
  try {
    const details = JSON.parse(result.stdout.trim()) as PythonDetails
    if (details.version[0] !== 3 || details.version[1] < 9 || !details.tag) return undefined
    return { ...details, hasPip: details.hasPip === true }
  } catch {
    return undefined
  }
}

async function discoverSystemPython(explicit?: string, signal?: AbortSignal): Promise<PreparedPython | undefined> {
  for (const candidate of commandCandidates(explicit)) {
    const details = await pythonDetails(candidate, signal)
    if (details) return { command: candidate, details, source: "system" }
  }
  return undefined
}

export function managedPythonRelease() {
  const key = `${platform()}-${arch()}` as keyof typeof MANAGED_PYTHON_ASSETS
  const selected = MANAGED_PYTHON_ASSETS[key]
  if (!selected) throw new RouterAssetError(
    "KRT_PYTHON_PLATFORM_UNSUPPORTED",
    `Managed Python ${MANAGED_PYTHON_VERSION} is unavailable for ${platform()}/${arch()}.`,
    { platform: platform(), arch: arch() },
  )
  const fileName = `cpython-3.12.14+${MANAGED_PYTHON_RELEASE}-${selected.target}-install_only_stripped.tar.gz`
  return {
    backend: "python",
    version: MANAGED_PYTHON_VERSION,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${MANAGED_PYTHON_RELEASE}/${fileName}`,
    sha256: selected.sha256,
    archive: "tar.gz" as const,
    rootDirectory: "python",
    markers: [selected.executable, "lib"],
    executable: selected.executable,
  }
}

export async function prepareManagedPython(
  policy: RouterAssetPolicy = {},
  signal = policy.signal,
): Promise<PreparedPython> {
  const release = managedPythonRelease()
  const asset = await prepareManagedRouterAsset(release, policy)
  const command = join(asset.directory, ...release.executable.split("/"))
  const details = await pythonDetails(command, signal)
  if (!details) throw new RouterAssetError(
    "KRT_MANAGED_PYTHON_INVALID",
    "The managed Python runtime could not be started or is older than Python 3.9.",
    { command, directory: asset.directory },
  )
  if (!details.hasPip) throw new RouterAssetError(
    "KRT_MANAGED_PYTHON_PIP_MISSING",
    "The managed Python runtime does not contain pip.",
    { command, directory: asset.directory },
  )
  return { command, details, source: asset.source }
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
  verifyPatch = false,
) {
  const entries = [
    ...dependencies,
    join(krtDirectory, "rust_router"),
    join(krtDirectory, "py_router"),
  ]
  return runProcess(
    pythonPath,
    [
      "-c",
      `import sys; sys.dont_write_bytecode=True; sys.path[:0]=${JSON.stringify(entries)}; from startup_checks import run_all_checks; run_all_checks()${verifyPatch ? "; import copilot_router_krt_patch" : ""}; print('ok')`,
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
  const requirementsPath = join(asset.directory, "requirements.txt")
  const requirements = await readFile(requirementsPath)
  const requirementsSha256 = createHash("sha256").update(requirements).digest("hex")
  const direct = await probeKrtPython(pythonPath, asset.directory, [], policy.signal)
  if (direct.exitCode === 0 && !direct.error) return []
  const parent = join(asset.cacheDirectory, "runtimes", "krt", KRT_MANAGED_VERSION)
  const target = join(parent, `${pythonTag}-${platform()}-${arch()}`)
  const marker = join(target, ".copilot-router-python.json")
  if (await readable(marker)) {
    const receipt = await readFile(marker, "utf8").then(
      value => JSON.parse(value) as { requirementsSha256?: unknown },
      () => undefined,
    ).catch(() => undefined)
    if (receipt?.requirementsSha256 === requirementsSha256) {
      const cached = await probeKrtPython(pythonPath, asset.directory, [target], policy.signal)
      if (cached.exitCode === 0 && !cached.error) return [target]
    }
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
      "-m", "pip", "--isolated", "install",
      "--disable-pip-version-check",
      "--no-input",
      "--cache-dir", join(asset.cacheDirectory, "pip-cache"),
      "--target", temporary,
      "--requirement", requirementsPath,
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
      requirementsFile: "requirements.txt",
      requirementsSha256,
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
  let python = await discoverSystemPython(options.pythonPath, options.assets?.signal)
  if (!python) python = await prepareManagedPython(options.assets)
  const asset = await prepareManagedRouterAsset({
    ...KRT_RELEASE,
    prepareDirectory: prepareReleaseDirectory,
  }, options.assets, override)
  let dependencyEntries: readonly string[]
  try {
    dependencyEntries = await preparePythonDependencies(
      asset, python.command, python.details.tag, options.assets ?? {},
    )
  } catch (error) {
    if (python.source !== "system") throw error
    python = await prepareManagedPython(options.assets)
    dependencyEntries = await preparePythonDependencies(
      asset, python.command, python.details.tag, options.assets ?? {},
    )
  }
  const patchDirectory = await packagedPatchDirectory()
  const pythonPathEntries = [patchDirectory, ...dependencyEntries]
  const finalProbe = await probeKrtPython(
    python.command,
    asset.directory,
    pythonPathEntries,
    options.assets?.signal,
    true,
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
    pythonSource: python.source,
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

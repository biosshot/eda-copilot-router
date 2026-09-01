import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { constants } from "node:fs"
import { arch, homedir, platform } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  prepareManagedRouterAsset,
  RouterAssetError,
  type PreparedRouterAsset,
  type RouterAssetPolicy,
} from "./assets.js"

export const KRT_MANAGED_VERSION = "0.21.3"
export const MANAGED_PYTHON_VERSION = "3.12.14-20260814"

const KRT_REQUIRED_CAPABILITIES = Object.freeze([
  "route.py:--json-out",
  "route_summary.py",
])

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
  url: "https://github.com/drandyhaas/KiCadRoutingTools/releases/download/v0.21.3/KiCadRoutingTools-0.21.3.zip",
  sha256: "fd6e9f880e5defbd1747f4a5437735184486fabece55ce8b2a1397c25b611a64",
  sizeBytes: 6_813_810,
  archive: "zip" as const,
  rootDirectory: "plugins",
  markers: [
    "py_router/route.py",
    "py_router/route_diff.py",
    "py_router/qfn_fanout.py",
    "py_router/route_summary.py",
    "krt_capabilities.py",
    "requirements.txt",
    "LICENSE",
  ],
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
  executable: string
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
    && await readable(join(path, "py_router", "route_summary.py"))
    && await readable(join(path, "krt_capabilities.py"))
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
      "The configured KRT development override does not satisfy the KRT 0.21.3 route, fanout, summary, and capability module contract.",
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

export type KrtPythonDiscoveryCandidate = Readonly<{
  command: string
  args: readonly string[]
  source: string
  /** Resolve a launcher such as Windows `py -3` to `sys.executable`. */
  resolveExecutable?: boolean
}>

export type KrtPythonDiscoveryContext = Readonly<{
  environment?: NodeJS.ProcessEnv
  currentPlatform?: string
  homeDirectory?: string
}>

function environmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const direct = environment[name]
  if (direct !== undefined) return direct
  const found = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase())
  return found ? environment[found] : undefined
}

async function childDirectories(root: string | undefined, pattern: RegExp) {
  if (!root) return []
  return readdir(root, { withFileTypes: true }).then(
    entries => entries
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => join(root, entry.name))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" })),
    () => [] as string[],
  )
}

/**
 * @internal Enumerate compatible system-Python locations for support tooling
 * and runtime discovery. Missing absolute paths are discarded before probing;
 * PATH commands and declared overrides are probed directly.
 */
export async function krtPythonDiscoveryCandidates(
  explicit?: string,
  context: KrtPythonDiscoveryContext = {},
): Promise<readonly KrtPythonDiscoveryCandidate[]> {
  const environment = context.environment ?? process.env
  const currentPlatform = context.currentPlatform ?? process.platform
  const homeDirectory = context.homeDirectory ?? homedir()
  const values: KrtPythonDiscoveryCandidate[] = []
  const append = (
    command: string | undefined,
    source: string,
    args: readonly string[] = [],
    resolveExecutable = false,
  ) => {
    if (!command) return
    const key = `${command}\u0000${args.join("\u0000")}`
    const normalize = (value: string) => currentPlatform === "win32" ? value.toLowerCase() : value
    if (values.some((item) => normalize(`${item.command}\u0000${item.args.join("\u0000")}`) === normalize(key))) return
    values.push({ command, args, source, ...(resolveExecutable ? { resolveExecutable: true } : {}) })
  }
  const appendExisting = async (
    command: string | undefined,
    source: string,
    args: readonly string[] = [],
    resolveExecutable = false,
  ) => {
    if (command && await readable(command)) append(command, source, args, resolveExecutable)
  }
  const appendPrefix = async (root: string | undefined, source: string) => {
    if (!root) return
    if (currentPlatform === "win32") {
      await appendExisting(join(root, "python.exe"), source)
      await appendExisting(join(root, "Scripts", "python.exe"), source)
    } else {
      await appendExisting(join(root, "bin", "python3"), source)
      await appendExisting(join(root, "bin", "python"), source)
    }
  }

  append(explicit, "option")
  for (const name of [
    "COPILOT_ROUTER_PYTHON",
    "KICAD_PYTHON",
    "PYTHON",
    "PYTHON_EXECUTABLE",
    "UV_PYTHON",
    "npm_config_python",
  ]) append(environmentValue(environment, name), `environment:${name}`)
  for (const name of ["VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONHOME"]) {
    await appendPrefix(environmentValue(environment, name), `environment:${name}`)
  }

  if (currentPlatform === "win32") {
    const local = environmentValue(environment, "LOCALAPPDATA")
    const user = environmentValue(environment, "USERPROFILE") ?? homeDirectory
    const programRoots = [
      environmentValue(environment, "ProgramFiles"),
      environmentValue(environment, "ProgramFiles(x86)"),
    ].filter((value): value is string => Boolean(value))

    const kicadRoots = [
      ...(local ? [join(local, "Programs", "KiCad")] : []),
      ...programRoots.map((root) => join(root, "KiCad")),
    ]
    for (const root of kicadRoots) for (const directory of await childDirectories(root, /^\d+(?:\.\d+)*$/)) {
      await appendExisting(join(directory, "bin", "python.exe"), "kicad")
    }

    const pythonRoots = [
      ...(local ? [join(local, "Programs", "Python")] : []),
      ...programRoots,
      ...programRoots.map((root) => join(root, "Python")),
    ]
    for (const root of pythonRoots) for (const directory of await childDirectories(root, /^Python(?:\d|$)/i)) {
      await appendExisting(join(directory, "python.exe"), "python-installation")
    }

    const pyenvRoot = environmentValue(environment, "PYENV_ROOT")
      ?? join(user, ".pyenv", "pyenv-win")
    for (const directory of await childDirectories(join(pyenvRoot, "versions"), /^\d/)) {
      await appendExisting(join(directory, "python.exe"), "pyenv")
    }
    for (const root of [
      join(user, "miniconda3"), join(user, "anaconda3"),
      ...(local ? [join(local, "miniconda3"), join(local, "anaconda3")] : []),
    ]) await appendPrefix(root, "conda-installation")
    await appendExisting(join(user, "scoop", "apps", "python", "current", "python.exe"), "scoop")

  } else {
    const pyenvRoot = environmentValue(environment, "PYENV_ROOT") ?? join(homeDirectory, ".pyenv")
    for (const directory of await childDirectories(join(pyenvRoot, "versions"), /^\d/)) {
      await appendExisting(join(directory, "bin", "python3"), "pyenv")
      await appendExisting(join(directory, "bin", "python"), "pyenv")
    }
    for (const root of [
      join(homeDirectory, "miniconda3"), join(homeDirectory, "anaconda3"), "/opt/conda",
    ]) await appendPrefix(root, "conda-installation")
    for (const command of [
      join(homeDirectory, ".local", "bin", "python3"),
      "/usr/local/bin/python3", "/usr/bin/python3",
      "/opt/homebrew/bin/python3", "/opt/local/bin/python3",
    ]) await appendExisting(command, "standard-installation")

    if (currentPlatform === "darwin") {
      for (const root of [
        "/Library/Frameworks/Python.framework/Versions",
        join(homeDirectory, "Library", "Frameworks", "Python.framework", "Versions"),
      ]) for (const directory of await childDirectories(root, /^\d/)) {
        await appendExisting(join(directory, "bin", "python3"), "python-framework")
      }
      for (const root of ["/opt/homebrew/opt", "/usr/local/opt"]) {
        for (const directory of await childDirectories(root, /^python(?:@|$)/i)) {
          await appendExisting(join(directory, "bin", "python3"), "homebrew")
        }
      }
      for (const application of [
        "/Applications/KiCad/KiCad.app",
        join(homeDirectory, "Applications", "KiCad", "KiCad.app"),
      ]) {
        const versions = join(application, "Contents", "Frameworks", "Python.framework", "Versions")
        await appendExisting(join(versions, "Current", "bin", "python3"), "kicad")
        for (const directory of await childDirectories(versions, /^(?:Current|\d)/)) {
          await appendExisting(join(directory, "bin", "python3"), "kicad")
        }
      }
    }
    if (currentPlatform === "linux") {
      await appendExisting("/snap/kicad/current/usr/bin/python3", "kicad-snap")
    }
  }

  append("python3", "path")
  append("python", "path")
  if (currentPlatform === "win32") {
    const local = environmentValue(environment, "LOCALAPPDATA")
    const windows = environmentValue(environment, "WINDIR")
    for (const launcher of [
      ...(local ? [join(local, "Programs", "Python", "Launcher", "py.exe")] : []),
      ...(windows ? [join(windows, "py.exe")] : []),
    ]) await appendExisting(launcher, "python-launcher", ["-3"], true)
    append("py", "path-launcher", ["-3"], true)
  }
  for (const minor of [15, 14, 13, 12, 11, 10, 9]) append(`python3.${minor}`, "path")
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

async function pythonDetails(
  command: string,
  signal?: AbortSignal,
  prefixArgs: readonly string[] = [],
) {
  const result = await runProcess(command, [
    ...prefixArgs,
    "-c",
    "import importlib.util,json,sys; print(json.dumps({'version':list(sys.version_info[:3]),'tag':sys.implementation.cache_tag,'hasPip':importlib.util.find_spec('pip') is not None,'executable':sys.executable}))",
  ], {}, signal)
  if (result.exitCode !== 0 || result.error) return undefined
  try {
    const details = JSON.parse(result.stdout.trim()) as PythonDetails
    if (details.version[0] !== 3 || details.version[1] < 9 || !details.tag || !details.executable) return undefined
    return { ...details, hasPip: details.hasPip === true }
  } catch {
    return undefined
  }
}

async function discoverSystemPython(explicit?: string, signal?: AbortSignal): Promise<PreparedPython | undefined> {
  for (const candidate of await krtPythonDiscoveryCandidates(explicit)) {
    const details = await pythonDetails(candidate.command, signal, candidate.args)
    if (!details) continue
    const executable = resolve(details.executable)
    if (candidate.resolveExecutable) {
      const resolvedDetails = await pythonDetails(executable, signal)
      if (resolvedDetails) return {
        command: resolve(resolvedDetails.executable), details: resolvedDetails, source: "system",
      }
      continue
    }
    return { command: executable, details, source: "system" }
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
    krtDirectory,
    join(krtDirectory, "rust_router"),
    join(krtDirectory, "py_router"),
  ]
  return runProcess(
    pythonPath,
    [
      "-c",
      `import sys; sys.dont_write_bytecode=True; sys.path[:0]=${JSON.stringify(entries)}; from startup_checks import run_all_checks; run_all_checks(); from krt_capabilities import capabilities,missing; gaps=missing(capabilities(${JSON.stringify(krtDirectory)}),${JSON.stringify(KRT_REQUIRED_CAPABILITIES)}); assert not gaps, '; '.join(gaps)${verifyPatch ? "; import copilot_router_krt_patch" : ""}; print('ok')`,
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

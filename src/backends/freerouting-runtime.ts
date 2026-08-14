import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  defaultRouterCacheDirectory,
  prepareManagedRouterAsset,
  RouterAssetError,
  type PreparedRouterAsset,
  type RouterAssetPolicy,
} from "./assets.js"

export const FREEROUTING_MANAGED_VERSION = "2.3.0"
export const FREEROUTING_MANAGED_JAR = `freerouting-${FREEROUTING_MANAGED_VERSION}.jar`

const FREEROUTING_RELEASE = Object.freeze({
  backend: "freerouting",
  version: FREEROUTING_MANAGED_VERSION,
  url: "https://github.com/freerouting/freerouting/releases/download/v2.3.0/freerouting-2.3.0.jar",
  sha256: "3cf18d608437740bc497db6b8ef5888e2e60a08de0def20691d1bad0c0e0ee24",
  sizeBytes: 62_995_156,
  archive: "file" as const,
  fileName: FREEROUTING_MANAGED_JAR,
  markers: [FREEROUTING_MANAGED_JAR],
})

export type FreeroutingRuntimeOptions = Readonly<{
  /** Optional local development override. End users do not need this. */
  jarPath?: string
  assets?: RouterAssetPolicy
}>

export type PreparedFreeroutingRuntime = Readonly<{
  jarPath: string
  directory: string
  version: string
  source: PreparedRouterAsset["source"]
  cacheDirectory: string
}>

async function readable(path: string | undefined) {
  if (!path) return false
  return access(path, constants.R_OK).then(() => true, () => false)
}

/** Prepare the pinned official Freerouting JAR without a manual download. */
export async function prepareFreeroutingRuntime(
  options: FreeroutingRuntimeOptions = {},
): Promise<PreparedFreeroutingRuntime> {
  const override = options.jarPath ?? process.env.COPILOT_ROUTER_FREEROUTING_JAR
  if (override && await readable(resolve(override))) return {
    jarPath: resolve(override),
    directory: dirname(resolve(override)),
    version: FREEROUTING_MANAGED_VERSION,
    source: "override",
    cacheDirectory: resolve(options.assets?.cacheDirectory ?? defaultRouterCacheDirectory()),
  }
  if (override) throw new RouterAssetError(
    "FREEROUTING_OVERRIDE_INVALID",
    "The configured Freerouting development override is not a readable JAR.",
    { jarPath: resolve(override) },
  )
  const asset = await prepareManagedRouterAsset(FREEROUTING_RELEASE, options.assets)
  return {
    jarPath: resolve(asset.directory, FREEROUTING_MANAGED_JAR),
    directory: asset.directory,
    version: FREEROUTING_MANAGED_VERSION,
    source: asset.source,
    cacheDirectory: asset.cacheDirectory,
  }
}

export function freeroutingManagedRelease() {
  return { ...FREEROUTING_RELEASE }
}

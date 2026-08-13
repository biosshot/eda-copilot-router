import type {
  CoreStatus,
  PcbPatchOperationV1,
  PcbPatchV1,
  PcbSnapshotV1,
  RoutingDiagnostic,
} from "../core/contracts.js"

export type RouterCapability =
  | "ordinary-routing"
  | "vias"
  | "zones"
  | "plane-stitching"
  | "differential-pairs"
  | "matched-length"
  | "impedance-controlled"
  | "preserve-existing-copper"

export type RouterBackendCapabilities = Readonly<{
  supported: readonly RouterCapability[]
  maxCopperLayers?: number
}>

export type BackendRouteRequest<TIntent = unknown> = Readonly<{
  snapshot: PcbSnapshotV1
  intent: TIntent
  scope: "full" | "declared-only"
  policy?: unknown
  signal?: AbortSignal
}>

export type BackendPreflightResult = Readonly<{
  diagnostics: readonly RoutingDiagnostic[]
}>

export type BackendRouteResult = Readonly<{
  operations: readonly PcbPatchOperationV1[]
  diagnostics?: readonly RoutingDiagnostic[]
  coreStatus?: CoreStatus
}>

/**
 * A backend receives only the normalized snapshot and serializable intent.
 * It must not call KiCad, EasyEDA, or another board editor.
 */
export interface RouterBackendAdapter<TIntent = unknown> {
  readonly id: string
  readonly version: string
  readonly capabilities: RouterBackendCapabilities
  preflight?(
    request: BackendRouteRequest<TIntent>,
  ): BackendPreflightResult | Promise<BackendPreflightResult>
  route(request: BackendRouteRequest<TIntent>): Promise<BackendRouteResult>
}

export type BoardCaptureContext = Readonly<{
  signal?: AbortSignal
}>

export type BoardApplyContext = Readonly<{
  signal?: AbortSignal
  runNativeRefill?: boolean
  runNativeDrc?: boolean
}>

export type BoardApplyResult<TOutput> = Readonly<{
  output: TOutput
  diagnostics: readonly RoutingDiagnostic[]
  nativeVerification: "passed" | "failed" | "not-run"
}>

/**
 * The only EDA-aware boundary. A host captures once, runs the core while the
 * EDA is absent, then applies one patch. Adapter implementations own all
 * native transaction, refill, and DRC behavior.
 */
export interface BoardFormatAdapter<TInput = unknown, TOutput = TInput> {
  readonly id: string
  readonly version: string
  capture(input: TInput, context?: BoardCaptureContext): Promise<PcbSnapshotV1>
  apply(
    input: TInput,
    patch: PcbPatchV1,
    context?: BoardApplyContext,
  ): Promise<BoardApplyResult<TOutput>>
}

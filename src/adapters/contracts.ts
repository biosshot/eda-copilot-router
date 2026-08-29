import type {
  RoutingBoard,
  RoutingCopper,
  RoutingDiagnostic,
  RoutingMetrics,
  RoutingResult,
  RoutingRules,
} from "../core/contracts.js"
import type { CompiledRoutingProgram } from "../intent/types.js"
import type { ResolvedRoutePlan } from "../core/route-plan.js"

export type RouterCapability =
  | "ordinary-routing"
  | "vias"
  | "zones"
  | "plane-stitching"
  | "differential-pairs"
  | "matched-length"
  | "impedance-controlled"
  | "preserve-fixed-copper"
  | "fixed-zone-obstacles"
  | "preconnected-pad-groups"
  | "parallel-vias"

export type RouterBackendCapabilities = Readonly<{
  supported: readonly RouterCapability[]
  maxCopperLayers?: number
}>

export type BackendRouteRequest = Readonly<{
  board: RoutingBoard
  program: CompiledRoutingProgram
  /** Board-aware semantic plan. Backends must not derive policy from DSL syntax. */
  plan: ResolvedRoutePlan
  rules: RoutingRules
  connectivity?: Readonly<{
    /** Pads already joined by router-owned copper generated before routing. */
    preconnectedPadGroups: readonly Readonly<{
      net: string
      pads: readonly Readonly<{ component: string; pad: string }>[]
    }>[]
  }>
  signal?: AbortSignal
}>

export type BackendRouteResult = Readonly<{
  status: "complete" | "partial" | "error"
  copper: RoutingCopper
  diagnostics?: readonly RoutingDiagnostic[]
  metrics?: Partial<RoutingMetrics>
}>

/** Backends only translate normalized routing data to and from an engine. */
export interface RouterBackendAdapter {
  readonly id: string
  readonly capabilities: RouterBackendCapabilities
  preflight?(request: BackendRouteRequest): readonly RoutingDiagnostic[] | Promise<readonly RoutingDiagnostic[]>
  route(request: BackendRouteRequest): Promise<BackendRouteResult>
}

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

/** EDA conversion lives outside the router core. */
export interface BoardFormatAdapter<TInput = unknown, TOutput = TInput> {
  readonly id: string
  import(input: TInput, context?: Readonly<{ signal?: AbortSignal }>): Promise<RoutingBoard>
  apply(
    input: TInput,
    result: RoutingResult,
    context?: BoardApplyContext,
  ): Promise<BoardApplyResult<TOutput>>
}

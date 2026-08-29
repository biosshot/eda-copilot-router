import type { RoutingBoard, RoutingCopper, RoutingDiagnostic } from "./contracts.js"
import { validateRoutingCopper } from "./validation.js"

export type CopperCheckpoint = Readonly<{
  copper: RoutingCopper
  accepted: boolean
  diagnostics: readonly RoutingDiagnostic[]
}>

/**
 * A core-owned postprocessor is never allowed to erase the last applicable
 * snapshot. Invalid later geometry is reported while the previous copper is
 * retained for a partial result.
 */
export function retainCopperCheckpoint(
  board: RoutingBoard,
  previous: RoutingCopper,
  candidate: RoutingCopper,
  stage: string,
): CopperCheckpoint {
  const validation = validateRoutingCopper(candidate, board)
  if (validation.ok) return { copper: candidate, accepted: true, diagnostics: [] }
  return {
    copper: previous,
    accepted: false,
    diagnostics: [{
      code: "ROUTING_CHECKPOINT_REJECTED",
      severity: "error",
      message: `${stage} produced structurally invalid copper; the last applicable checkpoint was retained.`,
      details: { stage, validation: validation.diagnostics },
    }],
  }
}

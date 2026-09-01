import type { BackendRouteRequest } from "../adapters/contracts.js"

const KRT_PRE_ROUTE_BASELINE = Symbol("krt-pre-route-baseline")

type KrtRequestWithPreRouteBaseline = BackendRouteRequest & Readonly<{
  [KRT_PRE_ROUTE_BASELINE]?: BackendRouteRequest
}>

/** Preserve Hybrid's original board without extending the public request contract. */
export function withKrtPreRouteBaseline(
  request: BackendRouteRequest,
  baseline: BackendRouteRequest,
): BackendRouteRequest {
  const marked = { ...request } as KrtRequestWithPreRouteBaseline
  Object.defineProperty(marked, KRT_PRE_ROUTE_BASELINE, { value: baseline })
  return marked
}

export function krtPreRouteBaseline(request: BackendRouteRequest) {
  return (request as KrtRequestWithPreRouteBaseline)[KRT_PRE_ROUTE_BASELINE]
}

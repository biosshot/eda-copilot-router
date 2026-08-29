import type { RoutingBoard } from "./contracts.js"

/**
 * Conservative O(pads) physical span for each net.  The bounding-box diagonal
 * is an upper bound on every terminal-to-terminal Euclidean distance, so a net
 * is classified as short only when all of its pads really fit in that radius.
 * This avoids both quadratic terminal graphs and the routed-length feedback
 * loop where a bad detour makes a physically short net stop looking short.
 */
export function netTerminalSpansMm(board: Pick<RoutingBoard, "pads">) {
  const bounds = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; count: number }>()
  for (const pad of board.pads) {
    if (!pad.net) continue
    const current = bounds.get(pad.net)
    if (current) {
      current.minX = Math.min(current.minX, pad.at.x)
      current.minY = Math.min(current.minY, pad.at.y)
      current.maxX = Math.max(current.maxX, pad.at.x)
      current.maxY = Math.max(current.maxY, pad.at.y)
      current.count += 1
    } else bounds.set(pad.net, {
      minX: pad.at.x,
      minY: pad.at.y,
      maxX: pad.at.x,
      maxY: pad.at.y,
      count: 1,
    })
  }
  return new Map([...bounds].map(([net, item]) => [
    net,
    item.count >= 2 ? Math.hypot(item.maxX - item.minX, item.maxY - item.minY) : undefined,
  ]))
}

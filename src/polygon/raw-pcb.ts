// RawPcb is the format boundary shared with the EasyEDA client. Keep this
// module type-only so the local router does not pull the EasyEDA runtime in.
export type {
  RawPcb,
  RawPcbArc,
  RawPcbComponent,
  RawPcbPad,
  RawPcbPolygon,
  RawPcbTrack,
  RawPcbVia,
} from "../../../easyeda-copilot/packages/shared/types/pcb/raw"

export type { PcbLayerName, PcbPoint } from "../../../easyeda-copilot/packages/shared/types/pcb/shared"

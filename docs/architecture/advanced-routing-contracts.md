# Advanced routing contracts

Status: accepted and implementation-owned
Updated: 2026-08-20

This document is the canonical contract for automatic bus routing, controlled
impedance, zone behaviour, and via stitching. These intents remain
EDA-neutral; backend flags are an adapter detail.

## Automatic bus detection

```ts
interface BusDetectOptions {
  detectionRadiusMm?: number
  minNets?: number
  attractionRadiusMm?: number
}

declare function busDetect(enabled: boolean | BusDetectOptions): void
```

`busDetect(true)` enables backend-native detection without overriding backend
defaults. For KRT it emits only `--bus`. An object emits `--bus` plus only the
numeric fields explicitly present in that object. No router-owned numeric
defaults are substituted. `busDetect(false)` is equivalent to omission.

Bus detection applies to ordinary `route.py` routing and its completion work,
not differential-pair or fanout subcalls. It is a routing hint: KRT may demote
a detected group when it cannot find a suitable shared corridor.

## Controlled impedance

```ts
interface ImpedanceOptions {
  targetOhm: number
  tolerancePercent?: number
  referenceNet?: string | "auto"
}
```

The containing `signalNet` or `diffPair` determines whether `targetOhm` is
single-ended or differential. Omitted `referenceNet` means `"auto"`.

Topology, routing layer, reference layers, width, and coplanar gap are resolved
values and are not authorable impedance fields. Candidate routing layers come
from the effective `allowedLayers` rule. The core examines the resolved stack,
board-wide plane intents, and imported solid reference zones and classifies a
candidate as microstrip, symmetric/asymmetric stripline, unbacked coplanar
waveguide, or grounded coplanar waveguide. Missing or ambiguous reference
copper is an error.

For coplanar structures the electrical side gap is the effective DRC
separation that native refill will enforce: the maximum applicable signal,
reference-net, zone, and fabrication clearances. Hatched copper is not accepted
as a continuous controlled-impedance reference. The core resolves ordinary
fixed geometry and sends it to the backend; it does not perform a KRT
impedance pre-resolution round trip.

## Shared zone options

```ts
interface ZoneOptions {
  clearanceMm?: number
  minThicknessMm?: number
  fill?: {
    style?: "solid" | "hatched"
    hatchThicknessMm?: number
    hatchGapMm?: number
    hatchOrientationDeg?: number
  }
  padConnection?: {
    mode?: "solid" | "thermal" | "none"
    thermalGapMm?: number
    spokeWidthMm?: number
    spokeCount?: number
    spokeAngleDeg?: number
  }
  removeIslandsBelowMm2?: number
}
```

Compact polygons use `.zone(options)` and planes use `zone: options`. The
compact planner owns only the outline. Native refill owns solid/hatched fill,
thermal spokes, and island removal. Hatch-only fields require `style:
"hatched"`; thermal-only fields require `mode: "thermal"`; `spokeCount` is an
integer from 2 through 8. Angles are normalized to `[0, 180)`.

Defaults are solid fill, solid pad connection, effective net clearance,
router/fabrication minimum zone detail, and zero island-removal threshold.
Unsupported native output fields must produce a capability diagnostic rather
than be silently ignored.

## Unified via stitching

```ts
interface ViaStitchCommon {
  via?: Pick<ViaOptions, "diameterMm" | "drillMm"> | "drc-min"
  maxVias?: number
}

type ViaStitchOptions =
  | ViaStitchCommon & {
      mode: "grid"
      net: string
      region: RegionSelector
      pitchMm: number
      viaInPad?: boolean
    }
  | ViaStitchCommon & {
      mode: "along"
      net: string
      routes: string[]
      pitchMm?: number
      offsetMm?: number
      rows?: number
      rowSpacingMm?: number
      stagger?: boolean
    }
  | ViaStitchCommon & {
      mode: "around"
      net: string
      target: RegionSelector | FanoutTarget
      pitchMm?: number
      offsetMm?: number
      rows?: number
      side?: "inside" | "outside"
    }
  | ViaStitchCommon & {
      mode: "return"
      referenceNet: string | "auto"
      forNets?: string[]
      maxDistanceMm?: number
    }

declare function viaStitch(id: string, options: ViaStitchOptions): void
```

All generated vias are through vias; layer-span fields are intentionally not
part of this contract. `ViaOptions.from` and `ViaOptions.to` are likewise
hidden from all rule and stitching declarations for now. Every mode observes board/cutout edges, via keepouts,
copper and hole spacing, effective per-net rules, duplicate suppression, and
`maxVias`.

- `along` routes its source nets in the special stage, materializes the fence
  after successful source routing, and exposes the vias as fixed obstacles to
  remaining routing.
- `return` runs after ordinary completion. It places a reference via near each
  final signal via unless a compatible nearby return via already exists.
  Automatic reference selection uses the resolved impedance reference first,
  then an unambiguous actual solid plane; it never guesses from a net name.
- `grid` runs after plane creation and emits a candidate only where reference
  copper for the selected net exists on at least two layers.
- `around` follows an offset contour after main routing. Board contours default
  to `inside`; component and pad contours default to `outside`.

The former `viaFence` surface is a compatibility alias that compiles directly
to `viaStitch({ mode: "along" })`; there is no separate fence intent or
implementation.

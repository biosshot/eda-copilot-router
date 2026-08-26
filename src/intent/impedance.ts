/** Closed-form impedance approximations aligned with KRT 0.21.3. */

export type ResolvedImpedanceTopology =
  | "microstrip"
  | "stripline"
  | "coplanar-waveguide"
  | "grounded-coplanar-waveguide"

export type ImpedanceGeometry = Readonly<{
  topology: ResolvedImpedanceTopology
  copperThicknessMm: number
  relativePermittivity: number
  heightMm: number
  heightAboveMm?: number
  heightBelowMm?: number
  differentialGapMm?: number
  coplanarGapMm?: number
}>

function microstripAir(u: number) {
  if (u <= 0) return 0
  return u <= 1
    ? 60 * Math.log(8 / u + 0.25 * u)
    : 120 * Math.PI / (u + 1.393 + 0.667 * Math.log(u + 1.444))
}

function microstrip(width: number, h: number, thickness: number, er: number) {
  if (width <= 0 || h <= 0 || er <= 0) return 0
  const u = width / h
  let u1 = u
  let ur = u
  if (thickness > 0) {
    const th = Math.tanh(Math.sqrt(6.517 * u))
    const du1 = thickness / Math.PI * Math.log(1 + 4 * Math.E * h / thickness * th * th)
    const dur = 0.5 * (1 + 1 / Math.cosh(Math.sqrt(Math.max(er - 1, 0)))) * du1
    u1 = (width + du1) / h
    ur = (width + dur) / h
  }
  let effectiveEr = (er + 1) / 2 + (er - 1) / 2 / Math.sqrt(1 + 12 / ur)
  if (thickness > 0) {
    const denominator = microstripAir(ur)
    if (denominator > 0) effectiveEr *= (microstripAir(u1) / denominator) ** 2
  }
  return effectiveEr <= 0 ? 0 : microstripAir(ur) / Math.sqrt(effectiveEr)
}

function stripline(width: number, h: number, thickness: number, er: number) {
  if (width <= 0 || h <= 0 || er <= 0) return 0
  const b = 2 * h + thickness
  const m = 6 * h / (3 * h + thickness)
  const widthEffective = width + thickness / Math.PI * (1 - 0.5 * Math.log(
    (thickness / (2 * h + thickness)) ** 2
      + (thickness / (m * Math.PI * width + 1.1 * thickness)) ** 2,
  ))
  const correction = 1 / (1 + (widthEffective / b / 0.35) ** 2.5)
  return Math.max(0, 60 / Math.sqrt(er) * Math.log(1.9 * b / (0.8 * widthEffective + thickness) * (1 + correction * 0.4)))
}

function ellipticK(k: number) {
  if (k <= 0) return Math.PI / 2
  if (k >= 1) return 1e12
  let a = 1
  let b = Math.sqrt(1 - k * k)
  for (let index = 0; index < 60 && Math.abs(a - b) >= 1e-15 * Math.max(a, 1); index += 1) {
    const oldA = a
    a = (a + b) / 2
    b = Math.sqrt(oldA * b)
  }
  return a <= 0 ? 1e12 : Math.PI / (2 * a)
}

function kRatio(k: number) {
  const clamped = Math.min(1, Math.max(0, k))
  const complement = Math.sqrt(Math.max(0, 1 - clamped * clamped))
  const denominator = ellipticK(complement)
  return denominator <= 0 ? 1e12 : ellipticK(clamped) / denominator
}

function thicknessAdjusted(width: number, gap: number, thickness: number) {
  if (thickness <= 0) return { width, gap }
  const delta = 1.25 * thickness / Math.PI * (1 + Math.log(4 * Math.PI * width / thickness))
  return { width: width + delta, gap: Math.max(gap - delta, 1e-6) }
}

function cpw(width: number, gap: number, thickness: number, er: number) {
  if (width <= 0 || gap <= 0 || er <= 0) return 0
  const adjusted = thicknessAdjusted(width, gap, thickness)
  const k = adjusted.width / (adjusted.width + 2 * adjusted.gap)
  const effectiveEr = (er + 1) / 2
  const ratio = kRatio(k)
  return ratio <= 0 ? 0 : 30 * Math.PI / Math.sqrt(effectiveEr) / ratio
}

function groundedCpw(width: number, gap: number, h: number, thickness: number, er: number) {
  if (width <= 0 || gap <= 0 || h <= 0 || er <= 0) return 0
  const adjusted = thicknessAdjusted(width, gap, thickness)
  const a = adjusted.width / 2
  const b = a + adjusted.gap
  const k1 = a / b
  const tanhB = Math.tanh(Math.PI * b / (2 * h))
  const k3 = tanhB > 0 ? Math.tanh(Math.PI * a / (2 * h)) / tanhB : 1
  const r1 = kRatio(k1)
  const r3 = kRatio(k3)
  if (r1 <= 0 || r1 + r3 <= 0) return 0
  const q = r3 / r1
  let effectiveEr = (1 + er * q) / (1 + q)
  if (thickness > 0) {
    const tg = thickness / gap
    effectiveEr -= 0.7 * (effectiveEr - 1) * tg / (r1 + 0.7 * tg)
  }
  effectiveEr = Math.max(1, Math.min(er, effectiveEr))
  return 60 * Math.PI / Math.sqrt(effectiveEr) / (r1 + r3)
}

function singleEnded(width: number, geometry: ImpedanceGeometry) {
  const { topology, heightMm: h, copperThicknessMm: t, relativePermittivity: er } = geometry
  if (topology === "microstrip") return microstrip(width, h, t, er)
  if (topology === "coplanar-waveguide") return cpw(width, geometry.coplanarGapMm ?? 0, t, er)
  if (topology === "grounded-coplanar-waveguide") return groundedCpw(width, geometry.coplanarGapMm ?? 0, h, t, er)
  const h1 = geometry.heightAboveMm ?? h
  const h2 = geometry.heightBelowMm ?? h
  return stripline(width, 2 * h1 * h2 / (h1 + h2), t, er)
}

export function calculateImpedanceOhm(width: number, geometry: ImpedanceGeometry) {
  const z0 = singleEnded(width, geometry)
  const gap = geometry.differentialGapMm
  if (gap === undefined) return z0
  const h = geometry.topology === "stripline"
    ? 2 * (geometry.heightAboveMm ?? geometry.heightMm) * (geometry.heightBelowMm ?? geometry.heightMm)
      / ((geometry.heightAboveMm ?? geometry.heightMm) + (geometry.heightBelowMm ?? geometry.heightMm))
    : geometry.heightMm
  const coupling = geometry.topology === "stripline"
    ? 0.347 * Math.exp(-2.9 * gap / (2 * h))
    : 0.48 * Math.exp(-0.96 * gap / h)
  return 2 * z0 * (1 - coupling)
}

export function solveImpedanceWidthMm(targetOhm: number, geometry: ImpedanceGeometry) {
  let minimum = 0.01
  let maximum = 10
  const atMinimum = calculateImpedanceOhm(minimum, geometry)
  const atMaximum = calculateImpedanceOhm(maximum, geometry)
  if (!Number.isFinite(atMinimum) || !Number.isFinite(atMaximum)
    || targetOhm > atMinimum || targetOhm < atMaximum) return undefined
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (minimum + maximum) / 2
    const impedance = calculateImpedanceOhm(middle, geometry)
    if (impedance > targetOhm) minimum = middle
    else maximum = middle
  }
  return (minimum + maximum) / 2
}

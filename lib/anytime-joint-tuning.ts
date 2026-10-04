import { foldedPairedLobes, foldedTuningLobes } from "./folded-tuning"
import { offsetPath } from "./coupled-pair-routing"
import { CopperIndex } from "./copper-index"
import { AnytimeWaveCache } from "./anytime-wave-cache"
import { distance, length, simplify } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { pairCouplingReports } from "./pair-coupling"
import { routeAnglesAreConventional } from "./route-angle-validation"
import {
  busLengthReports,
  fixedRouteLength,
  lengthConstraints,
  pairLengthReports,
} from "./route-lengths"
import {
  roundedPairedLobes,
  roundedTuningLobes,
  smoothPairedLobes,
  smoothTuningLobes,
} from "./smooth-tuning"
import type {
  AnytimeTuningBank,
  AnytimeTuningBankMember,
} from "./anytime-skeleton"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"
import {
  fixedCopper,
  routeCopper,
  VectorScene,
  type Copper,
} from "./vector-scene"

export interface JointTuningOptions {
  /** Bank handoffs indexed onto the supplied skeletons, e.g. recovery.pockets. */
  banks?: AnytimeTuningBank[]
  /** Previously accepted carrier geometry, used to prioritize known open sides. */
  preservedTraces?: Trace[]
  targetSkewFractions?: number[]
  /** Preserving the accepted shared bank supplies a known feasible pair floor. */
  pairedTargetModes?: ("preserve" | "minimum" | "known_pockets")[]
  /** Geometric attempts, including rejected attempts, across all transactions. */
  maxCandidates?: number
  maxPlacementsPerGroup?: number
  maxCells?: number
  /** Disable only when the transaction caller checks full-route self-clearance. */
  validateSelfClear?: boolean
  /** Preserve future accepted bank footprints while earlier groups are placed.
   * Leave false for transactions that deliberately change shared corridors. */
  reserveFutureBanks?: boolean
  /** Diagnostics only; observes each bounded placement and full transaction. */
  onAttempt?: (progress: JointTuningProgress) => void
  /** Diagnostic hook for locally feasible unfinished transactions. */
  onPartialCandidate?: (traces: Trace[], depth: number) => void
}

export interface JointTuningProgress {
  attempts: number
  depth: number
  groups: number
  members?: string[]
  amountMm?: number
  reason:
    | "candidate"
    | "pattern_geometry"
    | "stale_handoff"
    | "length"
    | "angles"
    | "clearance"
    | "self_clearance"
    | "complete_matching"
    | "complete_angles"
    | "complete_clearance"
    | "complete"
}

interface Group {
  amount: number
  banks: AnytimeTuningBank[]
  members: number[]
}
interface Pattern {
  cells: number
  radius: number
  fraction: number
  position: number
  side: number
  folded: boolean
  smooth?: boolean
}

/** Least electrical target vector above the skeleton lengths. Overlapping
 * constraints propagate through the complete cohort rather than tuning lanes
 * independently against an obsolete length ceiling. */
export function jointLengthTargets(
  input: SimpleRouteJson,
  traces: Trace[],
  skewFraction = 1,
): Map<string, number> | null {
  if (!Number.isFinite(skewFraction) || skewFraction < 0 || skewFraction > 1)
    return null
  const result = new Map(
    traces.map((t) => [
      t.connection_name!,
      length(t.route) + fixedRouteLength(input, t.connection_name!),
    ]),
  )
  const constraints = lengthConstraints(input)
  if (
    constraints.some(
      (c) =>
        c.names.some((n) => !result.has(n)) ||
        !Number.isFinite(c.tolerance) ||
        c.tolerance < 0,
    )
  )
    return null
  for (let pass = 0; pass < Math.max(1, result.size); pass++) {
    let changed = false
    for (const constraint of constraints) {
      const floor =
        Math.max(...constraint.names.map((n) => result.get(n)!)) -
        constraint.tolerance * skewFraction
      for (const name of constraint.names)
        if (result.get(name)! < floor - 1e-9) {
          result.set(name, floor)
          changed = true
        }
    }
    if (!changed) return result
  }
  return result
}

function segmentMember(
  trace: Trace,
  traceIndex: number,
  startIndex: number,
): AnytimeTuningBankMember {
  const start = trace.route[startIndex] as Wire,
    end = trace.route[startIndex + 1] as Wire
  const chordLengthMm = distance(start, end)
  return {
    traceIndex,
    connectionName: trace.connection_name!,
    startIndex,
    endIndex: startIndex + 1,
    start,
    end,
    chordLengthMm,
    originalLengthMm: chordLengthMm,
    deficitMm: 0,
  }
}

/** Ordinary straight segments supply additional pockets after a topology edit.
 * Shared pair segments are paired by tangent handoffs; never move one rail of
 * the coupled corridor by itself. */
function availableBanks(
  input: SimpleRouteJson,
  traces: Trace[],
  supplied: AnytimeTuningBank[],
) {
  // Shortcuts can remove or reindex an old handoff. A stale pocket cannot
  // remove arbitrary replacement topology or consume the placement budget.
  const result = supplied.flatMap((bank) => {
    const members: AnytimeTuningBankMember[] = []
    for (const member of bank.members) {
      const traceIndex = traces.findIndex(
        (t) => t.connection_name === member.connectionName,
      )
      if (traceIndex < 0) return []
      const trace = traces[traceIndex],
        range = locate(trace, member)
      if (
        !range ||
        Math.abs(
          length(trace.route.slice(range.start, range.end + 1)) -
            distance(member.start, member.end),
        ) > 1e-7
      )
        return []
      members.push({
        ...member,
        traceIndex,
        startIndex: range.start,
        endIndex: range.end,
        start: trace.route[range.start] as Wire,
        end: trace.route[range.end] as Wire,
        chordLengthMm: distance(member.start, member.end),
      })
    }
    return [{ ...bank, members }]
  })
  const covered = result.flatMap((b) => b.members)
  const shared = new Map<number, AnytimeTuningBankMember[]>()
  for (const [traceIndex, trace] of traces.entries()) {
    const curves = new Set(trace.curvedSegments)
    for (let i = 0; i < trace.route.length - 1; i++) {
      const a = trace.route[i],
        b = trace.route[i + 1]
      if (
        a.route_type !== "wire" ||
        b.route_type !== "wire" ||
        a.layer !== b.layer ||
        a.width !== b.width ||
        curves.has(i + 1) ||
        distance(a, b) < Math.max(0.25, a.width * 6) ||
        covered.some(
          (m) =>
            m.traceIndex === traceIndex &&
            i >= m.startIndex &&
            i + 1 <= m.endIndex,
        )
      )
        continue
      const member = segmentMember(trace, traceIndex, i)
      if (
        trace.coupledSection &&
        i >= trace.coupledSection[0] &&
        i < trace.coupledSection[1]
      ) {
        const list = shared.get(traceIndex) ?? []
        list.push(member)
        shared.set(traceIndex, list)
      } else
        result.push({
          id: `joint-pocket:${traceIndex}:${i}`,
          kind: "independent",
          members: [member],
        })
    }
  }
  for (const pair of input.differentialPairs ?? []) {
    const [first, second] = pair.connectionNames.map((name) =>
      traces.findIndex((t) => t.connection_name === name),
    )
    for (const a of shared.get(first) ?? [])
      for (const b of shared.get(second) ?? []) {
        const ux = (a.end.x - a.start.x) / a.chordLengthMm,
          uy = (a.end.y - a.start.y) / a.chordLengthMm
        const offset =
          -(b.start.x - a.start.x) * uy + (b.start.y - a.start.y) * ux
        if (
          a.start.layer !== b.start.layer ||
          a.start.width !== b.start.width ||
          Math.abs(a.chordLengthMm - b.chordLengthMm) > 1e-7 ||
          Math.abs(
            (b.start.x - a.start.x) * ux + (b.start.y - a.start.y) * uy,
          ) > 1e-7 ||
          Math.abs((b.end.x - a.end.x) * ux + (b.end.y - a.end.y) * uy) >
            1e-7 ||
          Math.abs(
            -(b.end.x - a.end.x) * uy + (b.end.y - a.end.y) * ux - offset,
          ) > 1e-7 ||
          Math.abs(offset) < a.start.width
        )
          continue
        result.push({
          id: `joint-pair-pocket:${first}:${a.startIndex}:${second}:${b.startIndex}`,
          kind: "paired",
          members: [a, b],
          spacingMm: Math.abs(offset),
        })
      }
  }
  return result
}

function preparedGroups(
  input: SimpleRouteJson,
  traces: Trace[],
  banks: AnytimeTuningBank[],
  fraction: number,
  pairedMode: "preserve" | "minimum" | "known_pockets" = "minimum",
): Group[] | null {
  const targets = jointLengthTargets(input, traces, fraction)
  if (!targets) return null
  const bases = traces.map(
    (t) => length(t.route) + fixedRouteLength(input, t.connection_name!),
  )
  const local = traces.map((_, index) =>
    banks.filter(
      (b) => b.kind === "independent" && b.members[0].traceIndex === index,
    ),
  )
  const paired = (input.differentialPairs ?? []).flatMap((pair) => {
    const members = pair.connectionNames.map((name) =>
      traces.findIndex((t) => t.connection_name === name),
    )
    const pockets = banks.filter(
      (b) =>
        b.kind === "paired" &&
        b.members.every((m) => members.includes(m.traceIndex)),
    )
    return pockets.length ? [{ members, pockets }] : []
  })
  // A rail without an independent approach pocket can only gain shared
  // length. Propagate that equality together with overlapping bus bounds.
  let stable = false
  for (let pass = 0; pass <= traces.length * 2; pass++) {
    let changed = false
    for (const { members, pockets } of paired) {
      if (pairedMode === "preserve") {
        const preservedShared = pockets.reduce(
          (sum, bank) =>
            sum + Math.min(...bank.members.map((m) => m.deficitMm)),
          0,
        )
        for (const i of members)
          if (
            targets.get(traces[i].connection_name!)! <
            bases[i] + preservedShared - 1e-9
          ) {
            targets.set(traces[i].connection_name!, bases[i] + preservedShared)
            changed = true
          }
      }
      const sharedFloor = Math.max(
        0,
        ...members
          .filter((i) => pairedMode === "known_pockets" || !local[i].length)
          .map(
            (i) =>
              targets.get(traces[i].connection_name!)! -
              bases[i] -
              (pairedMode === "known_pockets"
                ? local[i].reduce(
                    (sum, bank) => sum + bank.members[0].deficitMm,
                    0,
                  )
                : 0),
          ),
      )
      for (const i of members)
        if (
          targets.get(traces[i].connection_name!)! <
          bases[i] + sharedFloor - 1e-9
        ) {
          targets.set(traces[i].connection_name!, bases[i] + sharedFloor)
          changed = true
        }
    }
    for (const constraint of lengthConstraints(input)) {
      const floor =
        Math.max(...constraint.names.map((n) => targets.get(n)!)) -
        constraint.tolerance * fraction
      for (const name of constraint.names)
        if (targets.get(name)! < floor - 1e-9) {
          targets.set(name, floor)
          changed = true
        }
    }
    if (!changed) {
      stable = true
      break
    }
  }
  if (!stable) return null
  const remaining = traces.map((t, i) =>
    Math.max(0, targets.get(t.connection_name!)! - bases[i]),
  )
  const groups: Group[] = []
  for (const { members, pockets } of paired) {
    const amount = Math.min(...members.map((i) => remaining[i]))
    if (amount <= 1e-7) continue
    groups.push({ amount, banks: pockets, members })
    members.forEach((i) => {
      remaining[i] = Math.max(0, remaining[i] - amount)
    })
  }
  for (const [i, amount] of remaining.entries()) {
    if (amount <= 1e-7) continue
    if (!local[i].length) return null
    groups.push({ amount, banks: local[i], members: [i] })
  }
  // Sparse groups are the hardest to fit. Shared rails are assigned before
  // residual approach corrections, whose handoffs are resolved geometrically.
  return groups.sort(
    (a, b) =>
      b.members.length - a.members.length ||
      a.banks.length - b.banks.length ||
      b.amount - a.amount ||
      a.members[0] - b.members[0],
  )
}

function knownSide(bank: AnytimeTuningBank, preserved: Trace[] | undefined) {
  const member = bank.members[0],
    trace = preserved?.find((t) => t.connection_name === member.connectionName)
  if (!trace) return 1
  const start = member.originalStartIndex ?? member.startIndex,
    end = member.originalEndIndex ?? member.endIndex
  if (
    !trace.route[start] ||
    !trace.route[end] ||
    distance(trace.route[start], member.start) > 1e-7 ||
    distance(trace.route[end], member.end) > 1e-7
  )
    return 1
  const span = distance(member.start, member.end),
    ux = (member.end.x - member.start.x) / span,
    uy = (member.end.y - member.start.y) / span
  let strongest = 0
  for (const p of trace.route.slice(start, end + 1)) {
    const offset = -(p.x - member.start.x) * uy + (p.y - member.start.y) * ux
    if (Math.abs(offset) > Math.abs(strongest)) strongest = offset
  }
  return strongest < 0 ? -1 : 1
}

function* patterns(
  bank: AnytimeTuningBank,
  amount: number,
  tier: number,
  options: JointTuningOptions,
  clearance: number,
): Generator<Pattern> {
  const wire = bank.members[0].start,
    span = bank.members[0].chordLengthMm
  const spacing = bank.spacingMm ?? 0
  const usual = Math.max(wire.width * 1.2, clearance),
    // Returning centerlines need width+clearance separation. Quarter-arc
    // radius is half that pitch, with room for sampled-chord sagitta.
    compact =
      (wire.width + clearance) / 2 + Math.max(0.0005, wire.width * 0.005)
  const radii = tier === 0 ? [usual, compact] : [compact, usual]
  const side = knownSide(bank, options.preservedTraces)
  const queues: Pattern[][] = []
  for (const fraction of tier === 0
    ? [0.9, 1, 0.65]
    : tier === 1
      ? [1, 0.85, 0.65, 0.4]
      : [0.65, 0.45, 0.25, 1])
    for (const rank of [0, 1, 2])
      for (const form of ["rounded", "smooth", "folded"] as const) {
        const values: Pattern[] = []
        for (const position of [0.5, 0, 1])
          for (const [radius, orientation] of [
            [radii[0], side],
            [radii[1], -side],
            [radii[1], side],
            [radii[0], -side],
          ]) {
            const maximum = Math.min(
              options.maxCells ?? 48,
              Math.floor((span * fraction) / (4 * (radius + spacing / 2))),
              Math.floor(
                amount /
                  ((radius + spacing / 2) * (144 * Math.sin(Math.PI / 72) - 4)),
              ),
            )
            const cells =
              form === "folded"
                ? foldedCellCount(
                    span * fraction,
                    amount,
                    radius + spacing / 2,
                    rank,
                    options.maxCells ?? 48,
                  )
                : form === "smooth"
                  ? rank + 1
                  : rank === 0
                    ? maximum
                    : rank === 1
                      ? Math.ceil(maximum / 2)
                      : 1
            if (cells < 1) continue
            values.push({
              cells,
              radius,
              fraction,
              position,
              side: orientation,
              folded: form === "folded",
              smooth: form === "smooth",
            })
          }
        if (values.length) queues.push(values)
      }
  // Round-robin widths, density ranks, and shape families before exhausting
  // radius/side/position alternatives for one bank width.
  const seen = new Set<string>()
  for (let round = 0; queues.some((q) => round < q.length); round++)
    for (const queue of queues) {
      const pattern = queue[round]
      if (!pattern) continue
      const key = JSON.stringify([
        pattern.cells,
        pattern.radius,
        pattern.fraction,
        pattern.fraction === 1 ? 0 : pattern.position,
        pattern.side,
        pattern.folded,
        pattern.smooth ?? false,
      ])
      if (seen.has(key)) continue
      seen.add(key)
      yield pattern
    }
}

function foldedCellCount(
  span: number,
  amount: number,
  radius: number,
  rank: number,
  limit: number,
) {
  if (span < 6 * radius) return 0
  const correction = 4 * (36 * Math.sin(Math.PI / 72) - 2),
    base = (4 + correction) * radius,
    minimum = Math.max(
      1,
      Math.ceil((amount - base) / (2 * span + correction * radius)),
    ),
    maximum = Math.min(
      64,
      limit,
      Math.floor((amount - base) / ((12 + correction) * radius)),
    )
  if (maximum < minimum) return 0
  return rank === 0
    ? minimum
    : rank === 1
      ? Math.ceil(Math.sqrt(minimum * maximum))
      : maximum
}

function locate(trace: Trace, member: AnytimeTuningBankMember) {
  const start = trace.route.findIndex(
    (p) =>
      p.route_type === "wire" &&
      p.layer === member.start.layer &&
      p.width === member.start.width &&
      distance(p, member.start) < 1e-8,
  )
  const end = trace.route.findIndex(
    (p, i) =>
      i > start &&
      p.route_type === "wire" &&
      p.layer === member.end.layer &&
      p.width === member.end.width &&
      distance(p, member.end) < 1e-8,
  )
  return start >= 0 && end > start ? { start, end } : null
}

function spliceBank(
  trace: Trace,
  member: AnytimeTuningBankMember,
  points: Point[],
): Trace | null {
  const range = locate(trace, member)
  if (!range) return null
  const first = trace.route[range.start] as Wire,
    last = trace.route[range.end] as Wire
  const clean = simplify([first, ...points, last])
  const replacement = clean.map(
    (p, i): Wire =>
      i === 0
        ? first
        : i === clean.length - 1
          ? last
          : {
              ...p,
              route_type: "wire",
              layer: first.layer,
              width: first.width,
            },
  )
  const added = replacement.length - (range.end - range.start + 1)
  return {
    ...trace,
    route: [
      ...trace.route.slice(0, range.start),
      ...replacement,
      ...trace.route.slice(range.end + 1),
    ],
    coupledSection: trace.coupledSection?.map((i) =>
      i >= range.end ? i + added : i,
    ) as [number, number] | undefined,
    curvedSegments: [
      ...(trace.curvedSegments ?? [])
        .filter((i) => i <= range.start || i > range.end)
        .map((i) => (i > range.end ? i + added : i)),
      ...replacement.slice(1).flatMap((p, i) => {
        const dx = Math.abs(p.x - replacement[i].x),
          dy = Math.abs(p.y - replacement[i].y)
        return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8
          ? [range.start + i + 1]
          : []
      }),
    ].sort((a, b) => a - b),
  }
}

function bankWaves(
  bank: AnytimeTuningBank,
  amount: number,
  pattern: Pattern,
): Point[][] | null {
  const first = bank.members[0],
    a = first.start,
    b = first.end,
    span = distance(a, b)
  const ux = (b.x - a.x) / span,
    uy = (b.y - a.y) / span
  const offset = span * (1 - pattern.fraction) * pattern.position
  const from = { x: a.x + ux * offset, y: a.y + uy * offset }
  const to = {
    x: from.x + ux * span * pattern.fraction,
    y: from.y + uy * span * pattern.fraction,
  }
  if (bank.kind === "independent") {
    const waves = (
      pattern.folded
        ? foldedTuningLobes
        : pattern.smooth
          ? smoothTuningLobes
          : roundedTuningLobes
    )(from, to, amount, pattern.cells, pattern.side, pattern.radius)
    return waves ? [[a, ...waves, b]] : null
  }
  const mate = bank.members[1]
  const centerFrom = {
    x: from.x + (mate.start.x - a.x) / 2,
    y: from.y + (mate.start.y - a.y) / 2,
  }
  const centerTo = {
    x: to.x + (mate.end.x - b.x) / 2,
    y: to.y + (mate.end.y - b.y) / 2,
  }
  const waves = (
    pattern.folded
      ? foldedPairedLobes
      : pattern.smooth
        ? smoothPairedLobes
        : roundedPairedLobes
  )(
    centerFrom,
    centerTo,
    bank.spacingMm!,
    amount,
    pattern.cells,
    pattern.side,
    pattern.radius,
  )
  if (!waves) return null
  const signedOffset = -(mate.start.x - a.x) * uy + (mate.start.y - a.y) * ux
  const ordered = signedOffset > 0 ? waves.toReversed() : waves
  return ordered.map((points, i) => [
    bank.members[i].start,
    ...points,
    bank.members[i].end,
  ])
}

/** Adjust only straight lobe legs across empty normal-coordinate gaps. Every
 * sampled arc stays rigid, retaining its accepted radius and paired offset.
 * This is preferable to affine contraction when an inside pair arc is tight. */
function contractBankLegs(
  bank: AnytimeTuningBank,
  amount: number,
  originals: Point[][],
  allowExpansion = false,
): Point[][] | null {
  const first = bank.members[0],
    span = first.chordLengthMm,
    ux = (first.end.x - first.start.x) / span,
    uy = (first.end.y - first.start.y) / span,
    normal = (p: Point) =>
      -(p.x - first.start.x) * uy + (p.y - first.start.y) * ux,
    along = (p: Point) =>
      (p.x - first.start.x) * ux + (p.y - first.start.y) * uy,
    endpoints = bank.members.flatMap((m) => [normal(m.start), normal(m.end)]),
    anchorMin = Math.min(...endpoints),
    anchorMax = Math.max(...endpoints)
  let current = originals
  for (let iteration = 0; iteration < 32; iteration++) {
    const reductions = current.map(
        (p, i) => length(p) - bank.members[i].chordLengthMm - amount,
      ),
      required = reductions[0]
    if (reductions.every((r) => Math.abs(r) < 1e-7)) return current
    if (
      (required < 0 && !allowExpansion) ||
      reductions.some((r) => Math.abs(r - required) > 1e-6)
    )
      return null
    const values = [...new Set(current.flat().map(normal))].sort(
        (a, b) => a - b,
      ),
      gaps: {
        min: number
        max: number
        positive: boolean
        crossings: number
        capacity: number
      }[] = []
    for (let k = 0; k < values.length - 1; k++) {
      const min = values[k],
        max = values[k + 1],
        gap = max - min,
        positive = min >= anchorMax - 1e-8,
        negative = max <= anchorMin + 1e-8
      if ((!positive && !negative) || gap < 2e-6) continue
      const counts: number[] = []
      let safe = true
      for (const points of current) {
        let count = 0
        for (let j = 1; j < points.length; j++) {
          const a = points[j - 1],
            b = points[j]
          if (
            Math.min(normal(a), normal(b)) >= max - 1e-8 ||
            Math.max(normal(a), normal(b)) <= min + 1e-8
          )
            continue
          if (Math.abs(along(a) - along(b)) > 1e-8) {
            safe = false
            break
          }
          count++
        }
        if (!safe) break
        counts.push(count)
      }
      if (!safe || !counts[0] || counts.some((n) => n !== counts[0])) continue
      gaps.push({
        min,
        max,
        positive,
        crossings: counts[0],
        capacity: (gap - 1e-6) * counts[0],
      })
    }
    gaps.sort((a, b) => b.capacity - a.capacity || a.min - b.min)
    const gap = gaps[0]
    if (!gap) return null
    const delta =
      required < 0
        ? required / gap.crossings
        : Math.min(required / gap.crossings, gap.max - gap.min - 1e-6)
    current = current.map((points, memberIndex) =>
      points.map((p, i) => {
        if (i === 0) return bank.members[memberIndex].start
        if (i === points.length - 1) return bank.members[memberIndex].end
        const coordinate = normal(p),
          weight = gap.positive
            ? Math.max(
                0,
                Math.min(1, (coordinate - gap.min) / (gap.max - gap.min)),
              )
            : Math.max(
                0,
                Math.min(1, (gap.max - coordinate) / (gap.max - gap.min)),
              ),
          shift = weight * delta * (gap.positive ? -1 : 1)
        return Math.abs(shift) < 1e-12
          ? p
          : { x: p.x - uy * shift, y: p.y + ux * shift }
      }),
    )
  }
  return null
}

/** Remove a complete paired wave between accepted horizontal handoffs. The
 * surviving arcs keep their longitudinal phase and radius. A straight chord
 * replaces both deleted rail intervals, then safe normal legs make the exact
 * remaining correction. Each alternative is checked against the real scene. */
function pairedPhaseAlternatives(
  bank: AnytimeTuningBank,
  amount: number,
  preserved: Trace[] | undefined,
): Point[][][] {
  if (bank.kind !== "paired") return []
  const originals: Point[][] = []
  for (const member of bank.members) {
    const trace = preserved?.find(
        (t) => t.connection_name === member.connectionName,
      ),
      start = member.originalStartIndex ?? member.startIndex,
      end = member.originalEndIndex ?? member.endIndex
    if (
      !trace ||
      !trace.route[start] ||
      !trace.route[end] ||
      distance(trace.route[start], member.start) > 1e-8 ||
      distance(trace.route[end], member.end) > 1e-8
    )
      return []
    originals.push(trace.route.slice(start, end + 1))
  }
  if (originals[0].length !== originals[1].length) return []
  const member = bank.members[0],
    ux = (member.end.x - member.start.x) / member.chordLengthMm,
    uy = (member.end.y - member.start.y) / member.chordLengthMm,
    normal = (p: Point) =>
      -(p.x - member.start.x) * uy + (p.y - member.start.y) * ux,
    along = (p: Point) =>
      (p.x - member.start.x) * ux + (p.y - member.start.y) * uy,
    handoffs: number[] = []
  for (let i = 1; i < originals[0].length; i++)
    if (
      originals.every(
        (points) =>
          Math.abs(normal(points[i]) - normal(points[i - 1])) < 1e-8 &&
          along(points[i]) > along(points[i - 1]) + 1e-8,
      )
    )
      handoffs.push(i)
  const choices: {
    points: Point[][]
    error: number
    start: number
    end: number
  }[] = []
  for (let i = 0; i < handoffs.length; i++)
    for (let j = i + 1; j < handoffs.length; j++) {
      const start = handoffs[i],
        end = handoffs[j]
      if (
        !originals.every(
          (points) =>
            Math.abs(normal(points[start]) - normal(points[end])) < 1e-8,
        )
      )
        continue
      const points = originals.map((rail) => [
          ...rail.slice(0, start + 1),
          ...rail.slice(end),
        ]),
        additions = points.map(
          (rail, k) => length(rail) - bank.members[k].chordLengthMm,
        )
      if (Math.abs(additions[0] - additions[1]) > 1e-6) continue
      const originalAddition = length(originals[0]) - member.chordLengthMm
      if (originalAddition - additions[0] < 1e-7) continue
      choices.push({
        points,
        error: Math.abs(additions[0] - amount),
        start,
        end,
      })
    }
  choices.sort(
    (a, b) =>
      a.error - b.error ||
      a.end - a.start - (b.end - b.start) ||
      a.start - b.start,
  )
  return choices.slice(0, 32).flatMap(({ points }) => {
    const corrected = contractBankLegs(bank, amount, points, true)
    return corrected ? [corrected] : []
  })
}

/** Retarget accepted banks perpendicular to their chords. Longitudinal
 * positions and exact handoffs stay fixed, so the original placement remains
 * available even when dense novel patterns cannot fit a congested cohort. */
function preservedWaves(
  bank: AnytimeTuningBank,
  amount: number,
  preserved: Trace[] | undefined,
): Point[][] | null {
  const originals: Point[][] = []
  for (const member of bank.members) {
    const trace = preserved?.find(
      (t) => t.connection_name === member.connectionName,
    )
    if (!trace) return null
    const start = member.originalStartIndex ?? member.startIndex,
      end = member.originalEndIndex ?? member.endIndex
    if (
      !trace.route[start] ||
      !trace.route[end] ||
      distance(trace.route[start], member.start) > 1e-8 ||
      distance(trace.route[end], member.end) > 1e-8 ||
      trace.route.slice(start, end + 1).some((p) => p.route_type !== "wire")
    )
      return null
    originals.push(trace.route.slice(start, end + 1))
  }
  const legAdjustment = contractBankLegs(bank, amount, originals, true)
  if (legAdjustment) return legAdjustment
  if (bank.kind === "paired") {
    // Scaling rails independently would change the gap. Preserve an unchanged
    // shared corridor exactly, or contract its centerline and offset both rails.
    if (
      originals.every(
        (points, i) =>
          Math.abs(length(points) - bank.members[i].chordLengthMm - amount) <
          1e-7,
      )
    )
      return originals
    if (
      originals[0].length !== originals[1].length ||
      !bank.spacingMm ||
      originals.some(
        (points, i) =>
          amount > length(points) - bank.members[i].chordLengthMm + 1e-7,
      )
    )
      return null
    const first = bank.members[0],
      mate = bank.members[1],
      span = first.chordLengthMm,
      start = {
        x: (first.start.x + mate.start.x) / 2,
        y: (first.start.y + mate.start.y) / 2,
      },
      end = {
        x: (first.end.x + mate.end.x) / 2,
        y: (first.end.y + mate.end.y) / 2,
      },
      ux = (end.x - start.x) / span,
      uy = (end.y - start.y) / span,
      side = -(first.start.x - start.x) * uy + (first.start.y - start.y) * ux,
      center = originals[0].map((p, i) => ({
        x: (p.x + originals[1][i].x) / 2,
        y: (p.y + originals[1][i].y) / 2,
      }))
    function pairedScaled(scale: number): Point[][] | null {
      const scaled = simplify(
        center.map((p, i) => {
          if (i === 0) return start
          if (i === center.length - 1) return end
          const along = (p.x - start.x) * ux + (p.y - start.y) * uy,
            normal = (-(p.x - start.x) * uy + (p.y - start.y) * ux) * scale
          return {
            x: start.x + along * ux - normal * uy,
            y: start.y + along * uy + normal * ux,
          }
        }),
      )
      try {
        return [side, -side].map((offset, i) => {
          const rail = offsetPath(scaled, offset)
          rail[0] = bank.members[i].start
          rail[rail.length - 1] = bank.members[i].end
          return rail
        })
      } catch {
        return null
      }
    }
    const collapsed = pairedScaled(0),
      highRails = pairedScaled(1)
    if (
      !collapsed ||
      !highRails ||
      collapsed.some(
        (p, i) => length(p) - bank.members[i].chordLengthMm > amount + 1e-7,
      ) ||
      highRails.some(
        (p, i) => length(p) - bank.members[i].chordLengthMm < amount - 1e-7,
      )
    )
      return null
    let low = 0,
      high = 1
    for (let iteration = 0; iteration < 44; iteration++) {
      const middle = (low + high) / 2,
        rails = pairedScaled(middle)
      if (!rails) return null
      const deficit =
        rails.reduce(
          (sum, p, i) => sum + length(p) - bank.members[i].chordLengthMm,
          0,
        ) / 2
      if (deficit < amount) low = middle
      else high = middle
    }
    const rails = pairedScaled((low + high) / 2)
    return rails?.every(
      (p, i) =>
        Math.abs(length(p) - bank.members[i].chordLengthMm - amount) < 1e-6,
    )
      ? rails
      : null
  }
  const member = bank.members[0],
    points = originals[0],
    span = member.chordLengthMm,
    oldAmount = length(points) - span
  if (amount > oldAmount + 1e-7 || span <= 0) return null
  if (Math.abs(amount - oldAmount) < 1e-8) return originals
  const ux = (member.end.x - member.start.x) / span,
    uy = (member.end.y - member.start.y) / span
  function scaled(scale: number): Point[] {
    return points.map((p, i) => {
      if (i === 0) return member.start
      if (i === points.length - 1) return member.end
      const along = (p.x - member.start.x) * ux + (p.y - member.start.y) * uy,
        normal =
          (-(p.x - member.start.x) * uy + (p.y - member.start.y) * ux) * scale
      return {
        x: member.start.x + along * ux - normal * uy,
        y: member.start.y + along * uy + normal * ux,
      }
    })
  }
  // Folded banks can retain longitudinal backtracking at zero height. A
  // contraction below that minimum must use a different bank construction.
  if (length(scaled(0)) - span > amount + 1e-7) return null
  let low = 0,
    high = 1
  for (let iteration = 0; iteration < 44; iteration++) {
    const middle = (low + high) / 2
    if (length(scaled(middle)) - span < amount) low = middle
    else high = middle
  }
  return [scaled((low + high) / 2)]
}

function allocationPlans(group: Group, tier: number) {
  const banks = [...group.banks].sort(
    (a, b) =>
      b.members[0].chordLengthMm - a.members[0].chordLengthMm ||
      a.id.localeCompare(b.id),
  )
  const plans = banks.map((bank) => [{ bank, amount: group.amount }])
  if (tier > 0)
    for (const count of [2, 3, 4]) {
      const selected: AnytimeTuningBank[] = []
      for (const bank of banks) {
        if (
          selected.some((old) =>
            old.members.some((a) =>
              bank.members.some(
                (b) =>
                  a.traceIndex === b.traceIndex &&
                  a.startIndex < b.endIndex &&
                  a.endIndex > b.startIndex,
              ),
            ),
          )
        )
          continue
        selected.push(bank)
        if (selected.length === count) break
      }
      if (selected.length !== count) continue
      const total = selected.reduce((s, b) => s + b.members[0].chordLengthMm, 0)
      plans.unshift(
        selected.map((bank) => ({
          bank,
          amount: (group.amount * bank.members[0].chordLengthMm) / total,
        })),
      )
    }
  const preserved = banks.filter((bank) => bank.members[0].deficitMm > 1e-8),
    capacity = preserved.reduce(
      (sum, bank) => sum + bank.members[0].deficitMm,
      0,
    )
  if (capacity > 1e-8 && capacity < group.amount - 1e-7) {
    // Keep a known legal bank while placing only the remaining correction in
    // a new pocket. Pair skew can transfer a small residual to an approach;
    // replacing its entire large bank needlessly makes that residual hard.
    for (const extra of banks
      .filter((bank) => !preserved.includes(bank))
      .toReversed())
      plans.unshift([
        ...preserved.map((bank) => ({
          bank,
          amount: bank.members[0].deficitMm,
        })),
        { bank: extra, amount: group.amount - capacity },
      ])
  }
  // Stretching accepted straight legs can increase capacity while leaving
  // their arcs and longitudinal phase intact. Try that complete coordinated
  // bank plan before exhausting new pockets for only the residual correction.
  if (capacity > 1e-8)
    plans.unshift(
      preserved.map((bank) => ({
        bank,
        amount: (group.amount * bank.members[0].deficitMm) / capacity,
      })),
    )
  return plans
}

/** Rebuild a complete matching cohort as one transaction. Each geometric trial
 * yields control. No provisional bank becomes an incumbent; callers receive
 * only complete matching alternatives, and retain their accepted route on
 * rejection, budget exhaustion, or a cohort with insufficient tuning pockets.
 * This searches geometric length allocation directly, without invoking the
 * legacy routing or refinement/matching pipeline. */
export function* jointTuningCandidates(
  input: SimpleRouteJson,
  skeletons: Trace[],
  options: JointTuningOptions = {},
): Generator<Trace[] | undefined> {
  if (
    skeletons.some(
      (t) => t.route.length < 2 || t.route.some((p) => p.route_type !== "wire"),
    )
  )
    return
  const maxCandidates = options.maxCandidates ?? 4096
  if (maxCandidates < 1) return
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const fixed = fixedCopper(input)
  const banks = availableBanks(input, skeletons, options.banks ?? [])
  // Search branches replace traces rather than mutating their geometry. Keep
  // conversions local to this generator so unchanged carriers can supply the
  // same copper to every bank trial without a process-wide geometry cache.
  const copperByTrace = new WeakMap<Trace, Copper[]>()
  const traceCopper = (trace: Trace) => {
    let copper = copperByTrace.get(trace)
    if (!copper) {
      copper = routeCopper(trace)
      copperByTrace.set(trace, copper)
    }
    return copper
  }
  const waves = new AnytimeWaveCache()
  const restore = (bank: AnytimeTuningBank, amount: number) =>
    waves.get(
      bank,
      "restore",
      amount,
      () => preservedWaves(bank, amount, options.preservedTraces),
      (paths) => paths?.reduce((sum, path) => sum + path.length, 0) ?? 0,
    )
  const phases = (bank: AnytimeTuningBank, amount: number) =>
    waves.get(
      bank,
      "phases",
      amount,
      () => pairedPhaseAlternatives(bank, amount, options.preservedTraces),
      (choices) =>
        choices.reduce(
          (sum, paths) =>
            sum + paths.reduce((count, path) => count + path.length, 0),
          0,
        ),
    )
  const mutableVertices = skeletons.map(
      (trace) => new Uint8Array(trace.route.length),
    ),
    mutableSegments = skeletons.map(
      (trace) => new Uint8Array(trace.route.length - 1),
    )
  for (const bank of banks)
    for (const member of bank.members) {
      for (let i = member.startIndex + 1; i < member.endIndex; i++)
        mutableVertices[member.traceIndex][i] = 1
      for (let i = member.startIndex; i < member.endIndex; i++)
        mutableSegments[member.traceIndex][i] = 1
    }
  const vertexReservations = skeletons.map((trace, traceIndex) => ({
    traceIndex,
    copper: [
      ...trace.route.flatMap((point, index) =>
        point.route_type !== "wire" || mutableVertices[traceIndex][index]
          ? []
          : [
              {
                a: point,
                b: point,
                radius: point.width / 2,
                layer: point.layer,
                owners: [trace.connection_name ?? ""],
              },
            ],
      ),
      ...traceCopper(trace).filter(
        (_, index) => !mutableSegments[traceIndex][index],
      ),
    ],
  }))
  const reservations = options.reserveFutureBanks
    ? banks.flatMap((bank) =>
        bank.members.flatMap((member) => {
          if (member.deficitMm <= 1e-8) return []
          const preserved = options.preservedTraces?.find(
              (trace) => trace.connection_name === member.connectionName,
            ),
            start = member.originalStartIndex ?? member.startIndex,
            end = member.originalEndIndex ?? member.endIndex
          if (
            !preserved?.route[start] ||
            !preserved.route[end] ||
            distance(preserved.route[start], member.start) > 1e-8 ||
            distance(preserved.route[end], member.end) > 1e-8
          )
            return []
          return [
            {
              traceIndex: member.traceIndex,
              copper: routeCopper({
                ...preserved,
                route: preserved.route.slice(start, end + 1),
              }),
            },
          ]
        }),
      )
    : []
  const fractions = (options.targetSkewFractions ?? [1, 0.5, 0]).filter(
    (f) => Number.isFinite(f) && f >= 0 && f <= 1,
  )
  let attempted = 0
  const pairVariants: NonNullable<JointTuningOptions["pairedTargetModes"]> =
    options.pairedTargetModes ??
    (options.preservedTraces &&
    banks.some((b) => b.kind === "paired" && b.members[0].deficitMm > 1e-7)
      ? ["preserve", "known_pockets", "minimum"]
      : ["minimum"])
  for (const tier of [0, 1, 2])
    for (const fraction of fractions)
      for (const pairedMode of pairVariants) {
        const groups = preparedGroups(
          input,
          skeletons,
          banks,
          fraction,
          pairedMode,
        )
        yield undefined
        if (!groups) continue
        const report = (depth: number, reason: JointTuningProgress["reason"]) =>
          options.onAttempt?.({
            attempts: attempted,
            depth,
            groups: groups.length,
            members: groups[depth]?.members.map(
              (i) => skeletons[i].connection_name!,
            ),
            amountMm: groups[depth]?.amount,
            reason,
          })
        function* search(
          index: number,
          current: Trace[],
        ): Generator<Trace[] | undefined> {
          if (index === groups!.length) {
            // A topology driver can require no additional length and therefore
            // never pass through a placement group's per-route angle check.
            if (!routeAnglesAreConventional(current)) {
              report(index, "complete_angles")
              yield undefined
              return
            }
            if (
              [
                ...busLengthReports(input, current),
                ...pairLengthReports(input, current),
              ].some((r) => r.toleranceMm !== null && !r.matched) ||
              pairCouplingReports(input, current).some((r) => !r.matched)
            ) {
              report(index, "complete_matching")
              yield undefined
              return
            }
            const copper = [...fixed, ...current.flatMap(traceCopper)]
            const layerIndices = new Map<string, CopperIndex>(),
              layerCounts = new Map<string, number>()
            for (const trace of current) {
              const layer = (trace.route[0] as Wire).layer
              layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1)
            }
            for (const trace of current) {
              const connection = input.connections.find(
                  (c) => c.name === trace.connection_name,
                ),
                wire = trace.route[0] as Wire
              let sharedIndex: CopperIndex | undefined
              // Tiny cohorts often have one dense bank beside a single chord.
              // Their filtered per-net index avoids querying that bank's own
              // copper; sharing wins once several lanes reuse the same scene.
              if (
                connection &&
                (layerCounts.get(connection.pointsToConnect[0].layer) ?? 0) > 3
              ) {
                const layer = connection.pointsToConnect[0].layer
                sharedIndex = layerIndices.get(layer)
                if (!sharedIndex) {
                  sharedIndex = new CopperIndex(
                    copper.filter((item) => item.layer === layer),
                  )
                  layerIndices.set(layer, sharedIndex)
                }
              }
              if (
                !connection ||
                !new VectorScene(
                  input,
                  connection,
                  wire.width,
                  copper,
                  sharedIndex,
                ).pathVisible(trace.route)
              ) {
                report(index, "complete_clearance")
                yield undefined
                return
              }
            }
            report(index, "complete")
            yield current
            return
          }
          const group = groups![index]
          // All other completed carriers and future lane reservations are
          // invariant while this group tries its bank patterns. Validate that
          // immutable union once through retained scenes; changing mates are
          // checked separately with the identical continuous scene predicate.
          const unfinished = new Set(
              groups!.slice(index + 1).flatMap((next) => next.members),
            ),
            groupMembers = new Set(group.members),
            background = [
              ...fixed,
              ...vertexReservations.flatMap((reservation) =>
                unfinished.has(reservation.traceIndex) &&
                !groupMembers.has(reservation.traceIndex)
                  ? reservation.copper
                  : [],
              ),
              ...reservations.flatMap((reservation) =>
                unfinished.has(reservation.traceIndex) &&
                !groupMembers.has(reservation.traceIndex)
                  ? reservation.copper
                  : [],
              ),
              ...current.flatMap((trace, i) =>
                groupMembers.has(i) || unfinished.has(i)
                  ? []
                  : traceCopper(trace),
              ),
            ],
            scenes = new Map<number, VectorScene>(),
            backgroundIndices = new Map<string, CopperIndex>(),
            oldLengths = new Map(
              group.members.map((i) => [i, length(current[i].route)]),
            )
          for (const allocation of allocationPlans(group, tier)) {
            const restored = allocation.map(({ bank, amount }) =>
              restore(bank, amount),
            )
            const phaseAlternatives = allocation.map(({ bank, amount }) =>
                phases(bank, amount),
              ),
              phaseTrials = Math.max(
                0,
                ...phaseAlternatives.map((a) => a.length),
              )
            const mixedRestoration = restored.some((waves) => !waves)
            const choices = allocation.map(({ bank, amount }) => {
              const values: Pattern[] = []
              for (const pattern of patterns(
                bank,
                amount,
                tier,
                options,
                clearance,
              )) {
                values.push(pattern)
                if (values.length >= (options.maxPlacementsPerGroup ?? 64))
                  break
              }
              return values
            })
            for (
              let trial = restored.every(Boolean) ? -1 : 0;
              trial < (options.maxPlacementsPerGroup ?? 64);
              trial++
            ) {
              if (attempted >= maxCandidates) return
              attempted++
              let candidate = [...current],
                valid = true,
                reason: JointTuningProgress["reason"] = "candidate"
              for (const [{ bank, amount }, ai] of allocation.map(
                (a, i) => [a, i] as const,
              )) {
                const pattern =
                  choices[ai][
                    (Math.max(0, trial - phaseTrials) + ai * 2) %
                      choices[ai].length
                  ]
                const waves =
                  trial >= 0 && trial < phaseTrials
                    ? (phaseAlternatives[ai][trial] ?? restored[ai])
                    : trial === -1 ||
                        (mixedRestoration &&
                          restored[ai] &&
                          trial < (options.maxPlacementsPerGroup ?? 64) / 2)
                      ? restored[ai]
                      : pattern && bankWaves(bank, amount, pattern)
                if (!waves) {
                  valid = false
                  reason = "pattern_geometry"
                  break
                }
                for (const [k, member] of bank.members.entries()) {
                  const changed = spliceBank(
                    candidate[member.traceIndex],
                    member,
                    waves[k],
                  )
                  if (!changed) {
                    valid = false
                    reason = "stale_handoff"
                    break
                  }
                  candidate[member.traceIndex] = changed
                }
                if (!valid) break
              }
              if (valid) {
                // Future lanes move as part of this transaction. Their provisional
                // straight skeletons need not be legal beside an already restored
                // bank. They are checked against all copper at transaction completion.
                for (const member of group.members) {
                  const trace = candidate[member],
                    wire = trace.route[0] as Wire
                  const connection = input.connections.find(
                    (c) => c.name === trace.connection_name,
                  )
                  if (
                    !connection ||
                    Math.abs(
                      length(trace.route) -
                        oldLengths.get(member)! -
                        group.amount,
                    ) > 1e-6
                  ) {
                    valid = false
                    reason = "length"
                    break
                  }
                  if (!routeAnglesAreConventional([trace])) {
                    valid = false
                    reason = "angles"
                    break
                  }
                  let scene = scenes.get(member)
                  if (!scene) {
                    let sharedIndex: CopperIndex | undefined
                    if (group.members.length > 1) {
                      const layer = connection.pointsToConnect[0].layer
                      sharedIndex = backgroundIndices.get(layer)
                      if (!sharedIndex) {
                        sharedIndex = new CopperIndex(
                          background.filter((copper) => copper.layer === layer),
                        )
                        backgroundIndices.set(layer, sharedIndex)
                      }
                    }
                    scene = new VectorScene(
                      input,
                      connection,
                      wire.width,
                      background,
                      sharedIndex,
                    )
                    scenes.set(member, scene)
                  }
                  if (
                    !scene.pathVisible(trace.route) ||
                    (group.members.length > 1 &&
                      !new VectorScene(
                        input,
                        connection,
                        wire.width,
                        group.members.flatMap((other) =>
                          other === member ? [] : traceCopper(candidate[other]),
                        ),
                      ).pathVisible(trace.route))
                  ) {
                    valid = false
                    reason = "clearance"
                    break
                  }
                  if (
                    options.validateSelfClear !== false &&
                    !tuningPathIsSelfClear(trace.route, wire.width + clearance)
                  ) {
                    valid = false
                    reason = "self_clearance"
                    break
                  }
                }
              }
              report(index, reason)
              if (valid) options.onPartialCandidate?.(candidate, index + 1)
              yield undefined
              if (valid) yield* search(index + 1, candidate)
              if (attempted >= maxCandidates) return
            }
          }
        }
        yield* search(0, skeletons)
        if (attempted >= maxCandidates) return
      }
}

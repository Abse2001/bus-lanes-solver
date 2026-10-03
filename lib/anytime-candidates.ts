import { foldedPairedLobes, foldedTuningLobes } from "./folded-tuning"
import { distance, length, simplify } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { roundedPairedLobes, roundedTuningLobes } from "./smooth-tuning"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

export interface CompactTuningCandidateOptions {
  /** Geometric trials, including rejected trials. Each trial yields control. */
  maxCandidates?: number
  maxCells?: number
  maxBanks?: number
  /** The caller validates matching bounds before accepting shorter banks. */
  lengthScales?: number[]
  /** Disable only when the caller runs the same full-route clearance check. */
  validateSelfClear?: boolean
}

interface TuningBank {
  traceIndex: number
  start: number
  end: number
  deficit: number
  mate?: TuningBank
  spacing?: number
}

const collinearForward = (a: Point, b: Point, c: Point) => {
  const x = b.x - a.x,
    y = b.y - a.y,
    u = c.x - b.x,
    v = c.y - b.y
  return x * u + y * v > 0 && Math.abs(x * v - y * u) < 1e-7
}

/** Curve metadata describes chords rather than whole banks. A rounded bank's
 * quarter-arcs are separated by at most three unmarked straight/45° chords. */
function tuningBanks(
  trace: Trace,
  traceIndex: number,
  shared = false,
): TuningBank[] {
  const curved = [...new Set(trace.curvedSegments ?? [])].sort((a, b) => a - b)
  const groups: number[][] = []
  for (const index of curved) {
    if (index <= 0 || index >= trace.route.length) continue
    const previous = groups.at(-1)
    if (previous && index - previous.at(-1)! <= 3) previous.push(index)
    else groups.push([index])
  }
  const banks: TuningBank[] = []
  for (const group of groups) {
    let start = group[0] - 1,
      end = group.at(-1)!
    const a = trace.route[start],
      b = trace.route[end],
      span = distance(a, b)
    if (span < 1e-6) continue
    const ux = (b.x - a.x) / span,
      uy = (b.y - a.y) / span
    const first = trace.route[start + 1],
      last = trace.route[end - 1]
    // A tuning bank returns to its baseline with forward terminal tangents.
    // Skip general rounded corners, which do not have these two handoffs.
    const parallel = (x: number, y: number) =>
      (x * ux + y * uy) / Math.hypot(x, y) > Math.cos(Math.PI / 18)
    if (!parallel(first.x - a.x, first.y - a.y)) continue
    if (!parallel(b.x - last.x, b.y - last.y)) continue
    const coupled = trace.coupledSection
    if (shared) {
      if (!coupled || start < coupled[0] || end > coupled[1]) continue
    } else if (coupled && start < coupled[1] && end > coupled[0]) continue
    const deficit = length(trace.route.slice(start, end + 1)) - span
    if (deficit <= 1e-6) continue
    banks.push({ traceIndex, start, end, deficit })
    // The adjacent baseline may be available for additional, lower cells.
    // Keep the original bank as an alternative if obstacles block expansion.
    if (
      start > 0 &&
      !curved.includes(start) &&
      collinearForward(trace.route[start - 1], a, b) &&
      (!coupled ||
        (shared
          ? start - 1 >= coupled[0]
          : start - 1 >= coupled[1] || end <= coupled[0]))
    )
      start--
    if (
      end + 1 < trace.route.length &&
      !curved.includes(end + 1) &&
      collinearForward(a, b, trace.route[end + 1]) &&
      (!coupled ||
        (shared
          ? end + 1 <= coupled[1]
          : start >= coupled[1] || end + 1 <= coupled[0]))
    )
      end++
    if (start !== group[0] - 1 || end !== group.at(-1))
      banks.push({ traceIndex, start, end, deficit })
  }
  return banks
}

interface Pattern {
  fraction: number
  position: number
  cells: number
  radius: number
  side: number
  folded: boolean
  lengthScale: number
}

function* bankPatterns(
  span: number,
  width: number,
  clearance: number,
  maxCells: number,
  deficit: number,
  lengthScales: number[],
  spacing = 0,
): Generator<Pattern> {
  const usualRadius = Math.max(1.2 * width, clearance)
  // The closest two returning arms are at least two radii apart. The final
  // self-clearance test verifies the full route with width + clearance.
  const compactRadius = Math.max(width, (width + clearance) / 2)
  const radii = [...new Set([usualRadius, compactRadius])]
  for (const fraction of [1, 0.85, 0.65, 0.45, 0.25]) {
    const capacities = radii.map((radius) => ({
      radius,
      maximum: Math.min(
        maxCells,
        Math.floor((span * fraction) / (4 * (radius + spacing / 2))),
        Math.floor(
          deficit /
            ((radius + spacing / 2) * (144 * Math.sin(Math.PI / 72) - 4)),
        ),
      ),
      foldedMaximum: Math.min(
        maxCells,
        8,
        Math.floor(
          (deficit / (radius + spacing / 2) -
            (144 * Math.sin(Math.PI / 72) - 4)) /
            (4 + 144 * Math.sin(Math.PI / 72)),
        ),
      ),
    }))
    // Interleave bend radii so even short effort budgets explore denser cells.
    // Dense normal cells lower the envelope; folded raster cells trade bank
    // width for height when a narrow pocket is more useful.
    const ranks = Math.max(
      ...capacities.map((c) => Math.max(c.maximum, c.foldedMaximum)),
    )
    for (let rank = 0; rank < ranks; rank++)
      for (const folded of [false, true])
        for (const lengthScale of lengthScales)
          for (const position of fraction === 1 ? [0.5] : [0.5, 0, 1])
            for (const side of [1, -1])
              for (const { radius, maximum, foldedMaximum } of capacities) {
                const cells = folded ? rank + 1 : maximum - rank
                if (cells < 1 || (folded && cells > foldedMaximum)) continue
                yield {
                  fraction,
                  position,
                  cells,
                  radius,
                  side,
                  folded,
                  lengthScale,
                }
              }
  }
}

const curveIndices = (points: Point[]) =>
  points.slice(1).flatMap((p, i) => {
    const dx = Math.abs(p.x - points[i].x),
      dy = Math.abs(p.y - points[i].y)
    return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8 ? [i + 1] : []
  })

function replaceBank(
  trace: Trace,
  bank: TuningBank,
  replacement: Point[],
): Trace {
  const wire = trace.route[0] as Wire
  const added = replacement.length - (bank.end - bank.start + 1)
  return {
    ...trace,
    route: [
      ...trace.route.slice(0, bank.start),
      ...replacement.map((p) => ({
        ...p,
        route_type: "wire" as const,
        layer: wire.layer,
        width: wire.width,
      })),
      ...trace.route.slice(bank.end + 1),
    ],
    coupledSection: trace.coupledSection?.map((i) =>
      i >= bank.end ? i + added : i,
    ) as [number, number] | undefined,
    curvedSegments: [
      ...(trace.curvedSegments ?? [])
        .filter((i) => i <= bank.start || i > bank.end)
        .map((i) => (i > bank.end ? i + added : i)),
      ...curveIndices(replacement).map((i) => i + bank.start),
    ].sort((a, b) => a - b),
  }
}

function jointBanks(input: SimpleRouteJson, traces: Trace[]): TuningBank[] {
  const result: TuningBank[] = []
  for (const pair of input.differentialPairs ?? []) {
    const [first, second] = pair.connectionNames.map((name) =>
      traces.findIndex((t) => t.connection_name === name),
    )
    if (first < 0 || second < 0) continue
    const rail = traces[first],
      mate = traces[second],
      wire = rail.route[0] as Wire,
      otherWire = mate.route[0] as Wire
    if (
      wire?.route_type !== "wire" ||
      otherWire?.route_type !== "wire" ||
      wire.width !== otherWire.width ||
      wire.layer !== otherWire.layer ||
      [rail, mate].some((t) => t.route.some((p) => p.route_type !== "wire"))
    )
      continue
    for (const bank of tuningBanks(rail, first, true)) {
      const a = rail.route[bank.start],
        b = rail.route[bank.end],
        span = distance(a, b),
        ux = (b.x - a.x) / span,
        uy = (b.y - a.y) / span
      for (const other of tuningBanks(mate, second, true)) {
        const c = mate.route[other.start],
          d = mate.route[other.end],
          offset = -(c.x - a.x) * uy + (c.y - a.y) * ux
        if (
          Math.abs(bank.deficit - other.deficit) > 1e-6 ||
          Math.abs((c.x - a.x) * ux + (c.y - a.y) * uy) > 1e-6 ||
          Math.abs((d.x - b.x) * ux + (d.y - b.y) * uy) > 1e-6 ||
          Math.abs(-(d.x - b.x) * uy + (d.y - b.y) * ux - offset) > 1e-6 ||
          Math.abs(offset) < wire.width
        )
          continue
        result.push({ ...bank, mate: other, spacing: Math.abs(offset) })
      }
    }
  }
  return result
}

/** Reshape existing tuning banks, usually without changing copper lengths.
 * Every trial yields, including rejected forms, so callers can set effort in
 * bounded deterministic steps and stop while retaining a valid incumbent.
 * Fixed fanouts remain immutable, and shared rails retain their paired geometry.
 * Shared-corridor banks move together as offsets of one tangent centerline;
 * independently matched package-approach banks remain eligible as well. */
export function* compactTuningCandidates(
  input: SimpleRouteJson,
  traces: Trace[],
  options: CompactTuningCandidateOptions = {},
): Generator<Trace[] | undefined> {
  const maxCandidates = options.maxCandidates ?? 16384,
    maxCells = Math.min(64, options.maxCells ?? 64),
    maxBanks = options.maxBanks ?? 64
  if (maxCandidates <= 0 || maxCells <= 0 || maxBanks <= 0) return
  const banks: TuningBank[] = []
  for (const [index, trace] of traces.entries()) {
    // A carrier bank cannot change layers, widths, or a via's position.
    const first = trace.route[0]
    if (
      first?.route_type === "wire" &&
      trace.route.every(
        (p) =>
          p.route_type === "wire" &&
          p.layer === first.layer &&
          p.width === first.width,
      )
    )
      banks.push(...tuningBanks(trace, index).slice(0, maxBanks - banks.length))
    yield undefined
    if (banks.length >= maxBanks) break
  }
  if (input.differentialPairs?.length && banks.length < maxBanks) {
    banks.push(...jointBanks(input, traces).slice(0, maxBanks - banks.length))
    yield undefined
  }
  if (!banks.length) return
  const fixed = fixedCopper(input)
  const copper = [...fixed, ...traces.flatMap(routeCopper)]
  const scenes = new Map<number, VectorScene>()
  const pairBackgrounds = new Map<number, ReturnType<typeof fixedCopper>>()
  const patterns = banks.map((bank) => {
    const trace = traces[bank.traceIndex],
      width = (trace.route[0] as Wire).width,
      clearance =
        input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
    return bankPatterns(
      distance(trace.route[bank.start], trace.route[bank.end]),
      width,
      clearance,
      maxCells,
      bank.deficit,
      (options.lengthScales ?? [1, 0.999, 0.99, 0.95]).filter(
        (s) => Number.isFinite(s) && s > 0 && s <= 1,
      ),
      bank.spacing,
    )
  })
  let attempted = 0,
    active = true
  while (active && attempted < maxCandidates) {
    active = false
    // Round-robin avoids spending a short effort budget on a single lane.
    for (const [index, bank] of banks.entries()) {
      if (attempted >= maxCandidates) return
      const pattern = patterns[index].next()
      if (pattern.done) continue
      active = true
      attempted++
      const trace = traces[bank.traceIndex],
        wire = trace.route[0] as Wire,
        a = trace.route[bank.start],
        b = trace.route[bank.end],
        span = distance(a, b),
        ux = (b.x - a.x) / span,
        uy = (b.y - a.y) / span
      const { fraction, position, cells, radius, side, folded, lengthScale } =
        pattern.value
      const offset = span * (1 - fraction) * position
      const from = { x: a.x + ux * offset, y: a.y + uy * offset },
        to = {
          x: from.x + ux * span * fraction,
          y: from.y + uy * span * fraction,
        }
      let waves: Point[][] | null
      if (bank.mate) {
        const mate = traces[bank.mate.traceIndex],
          c = mate.route[bank.mate.start],
          d = mate.route[bank.mate.end],
          centerFrom = {
            x: from.x + (c.x - a.x) / 2,
            y: from.y + (c.y - a.y) / 2,
          },
          centerTo = { x: to.x + (d.x - b.x) / 2, y: to.y + (d.y - b.y) / 2 }
        const paired = (folded ? foldedPairedLobes : roundedPairedLobes)(
          centerFrom,
          centerTo,
          bank.spacing!,
          bank.deficit * lengthScale,
          cells,
          side,
          radius,
        )
        const offset = -(c.x - a.x) * uy + (c.y - a.y) * ux
        waves = paired ? (offset > 0 ? paired.toReversed() : paired) : null
      } else {
        const lobes = (folded ? foldedTuningLobes : roundedTuningLobes)(
          from,
          to,
          bank.deficit * lengthScale,
          cells,
          side,
          radius,
        )
        waves = lobes ? [lobes] : null
      }
      if (!waves) {
        yield undefined
        continue
      }
      if (bank.mate) {
        const members = [bank, bank.mate]
        const changed = members.map((member, k) => {
          const trace = traces[member.traceIndex]
          return replaceBank(
            trace,
            member,
            simplify([
              trace.route[member.start],
              ...waves![k],
              trace.route[member.end],
            ]),
          )
        })
        let background = pairBackgrounds.get(index)
        if (!background) {
          background = [
            ...fixed,
            ...traces
              .filter((_, i) => !members.some((m) => m.traceIndex === i))
              .flatMap(routeCopper),
          ]
          pairBackgrounds.set(index, background)
        }
        const pairCopper = [...background, ...changed.flatMap(routeCopper)]
        const valid = changed.every((candidate, k) => {
          const old = traces[members[k].traceIndex],
            connection = input.connections.find(
              (c) => c.name === candidate.connection_name,
            )
          if (!connection) return false
          const scene = new VectorScene(
            input,
            connection,
            wire.width,
            pairCopper,
          )
          return (
            Math.abs(
              length(candidate.route) -
                (length(old.route) - members[k].deficit * (1 - lengthScale)),
            ) < 1e-6 &&
            scene.pathVisible(candidate.route) &&
            (options.validateSelfClear === false ||
              tuningPathIsSelfClear(
                candidate.route,
                wire.width / 2 + scene.margin,
              ))
          )
        })
        if (!valid || !routeAnglesAreConventional(changed)) {
          yield undefined
          continue
        }
        const result = [...traces]
        members.forEach((member, k) => {
          result[member.traceIndex] = changed[k]
        })
        yield result
        continue
      }
      const replacement = simplify([a, ...waves[0], b])
      let scene = scenes.get(bank.traceIndex)
      const connection = input.connections.find(
        (c) => c.name === trace.connection_name,
      )
      if (!connection) {
        yield undefined
        continue
      }
      if (!scene) {
        scene = new VectorScene(input, connection, wire.width, copper)
        scenes.set(bank.traceIndex, scene)
      }
      if (!scene.pathVisible(replacement)) {
        yield undefined
        continue
      }
      const candidate = replaceBank(trace, bank, replacement)
      const route = candidate.route
      if (
        Math.abs(
          length(route) -
            (length(trace.route) - bank.deficit * (1 - lengthScale)),
        ) > 1e-6 ||
        (options.validateSelfClear !== false &&
          !tuningPathIsSelfClear(route, wire.width / 2 + scene.margin))
      ) {
        yield undefined
        continue
      }
      if (!routeAnglesAreConventional([candidate])) {
        yield undefined
        continue
      }
      const result = [...traces]
      result[bank.traceIndex] = candidate
      yield result
    }
  }
}

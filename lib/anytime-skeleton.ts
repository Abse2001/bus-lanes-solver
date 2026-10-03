import { distance, length, simplify } from "./geometry"
import { fixedRouteLength } from "./route-lengths"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { ordinaryRunCandidates } from "./simplify-matched-traces"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

export interface AnytimeTuningBankMember {
  traceIndex: number
  connectionName: string
  startIndex: number
  endIndex: number
  start: Wire
  end: Wire
  deficitMm: number
  originalLengthMm: number
  chordLengthMm: number
  /** Present on recovery.pockets, whose startIndex/endIndex use skeleton indices. */
  originalStartIndex?: number
  originalEndIndex?: number
}

/** One independently removable bank, or two shared rails removed together. */
export interface AnytimeTuningBank {
  id: string
  kind: "independent" | "paired"
  members: AnytimeTuningBankMember[]
  spacingMm?: number
}

function traceBanks(trace: Trace, traceIndex: number) {
  const curves = [...new Set(trace.curvedSegments ?? [])]
    .filter((i) => i > 0 && i < trace.route.length)
    .sort((a, b) => a - b)
  const groups: number[][] = []
  for (const i of curves) {
    const previous = groups.at(-1)
    if (previous && i - previous.at(-1)! <= 3) previous.push(i)
    else groups.push([i])
  }
  const result: AnytimeTuningBankMember[] = []
  for (const group of groups) {
    const startIndex = group[0] - 1,
      endIndex = group.at(-1)!,
      points = trace.route.slice(startIndex, endIndex + 1),
      start = points[0],
      end = points.at(-1)!
    if (
      start.route_type !== "wire" ||
      end.route_type !== "wire" ||
      points.some(
        (p) =>
          p.route_type !== "wire" ||
          p.layer !== start.layer ||
          p.width !== start.width,
      )
    )
      continue
    const chordLengthMm = distance(start, end)
    if (chordLengthMm <= 1e-6) continue
    const ux = (end.x - start.x) / chordLengthMm,
      uy = (end.y - start.y) / chordLengthMm
    const forward = (a: Point, b: Point) => {
      const span = distance(a, b)
      return (
        span > 1e-10 &&
        ((b.x - a.x) * ux + (b.y - a.y) * uy) / span > Math.cos(Math.PI / 18)
      )
    }
    // These two near-parallel terminal tangents distinguish a closed tuning
    // excursion from an ordinary rounded corner. Its baseline is recoverable.
    if (!forward(start, points[1]) || !forward(points.at(-2)!, end)) continue
    const coupled = trace.coupledSection
    if (
      coupled &&
      startIndex < coupled[1] &&
      endIndex > coupled[0] &&
      (startIndex < coupled[0] || endIndex > coupled[1])
    )
      continue
    const originalLengthMm = length(points),
      deficitMm = originalLengthMm - chordLengthMm
    if (deficitMm <= 1e-6) continue
    result.push({
      traceIndex,
      connectionName: trace.connection_name ?? trace.pcb_trace_id,
      startIndex,
      endIndex,
      start: { ...start },
      end: { ...end },
      originalLengthMm,
      chordLengthMm,
      deficitMm,
    })
  }
  return result
}

const sharedMember = (trace: Trace, bank: AnytimeTuningBankMember) =>
  !!trace.coupledSection &&
  bank.startIndex >= trace.coupledSection[0] &&
  bank.endIndex <= trace.coupledSection[1]

/** Recover explicit bank handoffs and added lengths without invoking routing.
 * Shared banks require matching rail handoffs and deficits; an unmatched shared
 * arc stays intact. Fixed escapes remain the caller's responsibility. */
export function discoverAnytimeTuningBanks(
  input: SimpleRouteJson,
  traces: Trace[],
): AnytimeTuningBank[] {
  const members = traces.map(traceBanks)
  const banks: AnytimeTuningBank[] = []
  for (const pair of input.differentialPairs ?? []) {
    const [first, second] = pair.connectionNames.map((name) =>
      traces.findIndex((t) => t.connection_name === name),
    )
    if (first < 0 || second < 0) continue
    const consumed = new Set<number>()
    for (const a of members[first]) {
      if (!sharedMember(traces[first], a)) continue
      const ux = (a.end.x - a.start.x) / a.chordLengthMm,
        uy = (a.end.y - a.start.y) / a.chordLengthMm
      for (const [index, b] of members[second].entries()) {
        if (
          consumed.has(index) ||
          !sharedMember(traces[second], b) ||
          a.start.width !== b.start.width ||
          a.start.layer !== b.start.layer
        )
          continue
        const offset =
          -(b.start.x - a.start.x) * uy + (b.start.y - a.start.y) * ux
        if (
          Math.abs(a.deficitMm - b.deficitMm) > 1e-5 ||
          Math.abs(
            (b.start.x - a.start.x) * ux + (b.start.y - a.start.y) * uy,
          ) > 1e-6 ||
          Math.abs((b.end.x - a.end.x) * ux + (b.end.y - a.end.y) * uy) >
            1e-6 ||
          Math.abs(
            -(b.end.x - a.end.x) * uy + (b.end.y - a.end.y) * ux - offset,
          ) > 1e-6 ||
          Math.abs(offset) < a.start.width - 1e-8
        )
          continue
        consumed.add(index)
        banks.push({
          id: `paired:${a.connectionName}:${a.startIndex}-${a.endIndex}:${b.connectionName}:${b.startIndex}-${b.endIndex}`,
          kind: "paired",
          members: [a, b],
          spacingMm: Math.abs(offset),
        })
        break
      }
    }
  }
  for (const [index, group] of members.entries())
    for (const member of group) {
      if (sharedMember(traces[index], member)) continue
      banks.push({
        id: `independent:${member.connectionName}:${member.startIndex}-${member.endIndex}`,
        kind: "independent",
        members: [member],
      })
    }
  return banks.sort(
    (a, b) =>
      a.members[0].traceIndex - b.members[0].traceIndex ||
      a.members[0].startIndex - b.members[0].startIndex ||
      a.id.localeCompare(b.id),
  )
}

function stripAndMap(
  traces: Trace[],
  banks: AnytimeTuningBank[],
  selectedIds?: Iterable<string>,
) {
  const selected = selectedIds
    ? new Set(selectedIds)
    : new Set(banks.map((b) => b.id))
  const removals = new Map<number, AnytimeTuningBankMember[]>()
  for (const bank of banks) {
    if (!selected.has(bank.id)) continue
    for (const member of bank.members) {
      const list = removals.get(member.traceIndex) ?? []
      list.push(member)
      removals.set(member.traceIndex, list)
    }
  }
  const mappings: Map<number, number>[] = []
  const result = traces.map((trace, traceIndex): Trace => {
    const list = (removals.get(traceIndex) ?? []).sort(
      (a, b) => a.startIndex - b.startIndex,
    )
    const removed = new Uint8Array(trace.route.length)
    let previousEnd = -1
    for (const member of list) {
      if (
        member.startIndex < previousEnd ||
        member.startIndex < 0 ||
        member.endIndex >= trace.route.length ||
        member.endIndex <= member.startIndex ||
        distance(trace.route[member.startIndex], member.start) > 1e-8 ||
        distance(trace.route[member.endIndex], member.end) > 1e-8
      )
        throw Error(
          "Tuning-bank records must refer to nonoverlapping original carrier handoffs",
        )
      for (let i = member.startIndex + 1; i < member.endIndex; i++)
        removed[i] = 1
      previousEnd = member.endIndex
    }
    const mapping = new Map<number, number>()
    const route = trace.route.flatMap((p, i) => {
      if (removed[i]) return []
      mapping.set(i, mapping.size)
      return [{ ...p }]
    })
    mappings.push(mapping)
    const coupledSection = trace.coupledSection?.map((i) => {
      const mapped = mapping.get(i)
      if (mapped === undefined)
        throw Error("A bank cannot remove a coupled-section boundary")
      return mapped
    }) as [number, number] | undefined
    return {
      ...trace,
      route,
      coupledSection,
      curvedSegments: trace.curvedSegments
        ? [...new Set(trace.curvedSegments)]
            .flatMap((i) => {
              const a = mapping.get(i - 1),
                b = mapping.get(i)
              return a !== undefined && b !== undefined && b === a + 1
                ? [b]
                : []
            })
            .sort((a, b) => a - b)
        : undefined,
    }
  })
  return { traces: result, mappings, selected }
}

/** Remove all or specified bank IDs; paired IDs always remove both rails. The
 * returned scratch routes intentionally need not satisfy length matching. */
export function stripAnytimeTuningBanks(
  traces: Trace[],
  banks: AnytimeTuningBank[],
  selectedIds?: Iterable<string>,
): Trace[] {
  return stripAndMap(traces, banks, selectedIds).traces
}

/** The selected bank records reindexed onto the stripped scratch routes. */
export function skeletonBankPockets(
  traces: Trace[],
  banks: AnytimeTuningBank[],
  selectedIds?: Iterable<string>,
): AnytimeTuningBank[] {
  const { mappings, selected } = stripAndMap(traces, banks, selectedIds)
  return banks
    .filter((bank) => selected.has(bank.id))
    .map((bank) => ({
      ...bank,
      members: bank.members.map((member) => ({
        ...member,
        originalStartIndex: member.startIndex,
        originalEndIndex: member.endIndex,
        startIndex: mappings[member.traceIndex].get(member.startIndex)!,
        endIndex: mappings[member.traceIndex].get(member.endIndex)!,
        start: { ...member.start },
        end: { ...member.end },
      })),
    }))
}

export function recoverAnytimeSkeleton(
  input: SimpleRouteJson,
  traces: Trace[],
) {
  const banks = discoverAnytimeTuningBanks(input, traces)
  return {
    traces: stripAnytimeTuningBanks(traces, banks),
    banks,
    pockets: skeletonBankPockets(traces, banks),
  }
}

/** Nets defining a movable envelope boundary or a bus/pair length ceiling come
 * first. A large detour breaks ties before original order for deterministic work. */
export function skeletonDriverPriorities(
  input: SimpleRouteJson,
  traces: Trace[],
): number[] {
  const totals = traces.map(
    (t) => length(t.route) + fixedRouteLength(input, t.connection_name ?? ""),
  )
  const longest = new Set<number>()
  for (const names of [
    ...(input.buses ?? []).map((b) => b.connectionNames),
    ...(input.differentialPairs ?? []).map((p) => p.connectionNames),
  ]) {
    const indices = traces.flatMap((t, i) =>
      names.includes(t.connection_name ?? "") ? [i] : [],
    )
    const maximum = Math.max(...indices.map((i) => totals[i]))
    indices.forEach((i) => {
      if (totals[i] >= maximum - 1e-7) longest.add(i)
    })
  }
  const extrema = [Infinity, -Infinity, Infinity, -Infinity]
  const boundary = new Set<number>()
  for (const trace of traces)
    for (const p of trace.route) {
      const r =
        p.route_type === "wire"
          ? p.width / 2
          : (p.via_diameter ?? input.minViaPadDiameter ?? 0.3) / 2
      extrema[0] = Math.min(extrema[0], p.x - r)
      extrema[1] = Math.max(extrema[1], p.x + r)
      extrema[2] = Math.min(extrema[2], p.y - r)
      extrema[3] = Math.max(extrema[3], p.y + r)
    }
  traces.forEach((t, i) => {
    if (
      t.route.some((p) => {
        const r =
          p.route_type === "wire"
            ? p.width / 2
            : (p.via_diameter ?? input.minViaPadDiameter ?? 0.3) / 2
        return [p.x - r, p.x + r, p.y - r, p.y + r].some(
          (v, k) => Math.abs(v - extrema[k]) < 1e-7,
        )
      })
    )
      boundary.add(i)
  })
  const detour = traces.map(
    (t) => length(t.route) - distance(t.route[0], t.route.at(-1)!),
  )
  return traces
    .map((_, i) => i)
    .sort(
      (a, b) =>
        Number(boundary.has(b) || longest.has(b)) -
          Number(boundary.has(a) || longest.has(a)) ||
        Number(longest.has(b)) - Number(longest.has(a)) ||
        detour[b] - detour[a] ||
        a - b,
    )
}

export interface SkeletonShortcutOptions {
  maxCandidates?: number
  maxWindowsPerTrace?: number
}

interface ShortcutWindow {
  start: number
  end: number
  saving: number
}

function* traceShortcuts(
  trace: Trace,
  maxWindows: number,
): Generator<Trace | undefined> {
  const prefix = [0]
  for (let i = 1; i < trace.route.length; i++)
    prefix.push(prefix.at(-1)! + distance(trace.route[i - 1], trace.route[i]))
  const windows: ShortcutWindow[] = []
  for (let start = 0; start < trace.route.length - 2; start++)
    for (const span of [
      ...new Set([
        trace.route.length - 1,
        Math.ceil(trace.route.length / 2),
        32,
        16,
        8,
        4,
        2,
      ]),
    ]) {
      const end = Math.min(trace.route.length - 1, start + span)
      if (
        end < start + 2 ||
        (trace.coupledSection &&
          start < trace.coupledSection[1] &&
          end > trace.coupledSection[0])
      )
        continue
      const points = trace.route.slice(start, end + 1),
        first = points[0]
      if (
        first.route_type !== "wire" ||
        points.some(
          (p) =>
            p.route_type !== "wire" ||
            p.layer !== first.layer ||
            p.width !== first.width,
        )
      )
        continue
      const saving =
        prefix[end] -
        prefix[start] -
        distance(trace.route[start], trace.route[end])
      if (saving > 1e-7) windows.push({ start, end, saving })
    }
  windows.sort(
    (a, b) => b.saving - a.saving || a.start - b.start || b.end - a.end,
  )
  const seen = new Set<string>()
  for (const { start, end } of windows.slice(0, maxWindows)) {
    const a = trace.route[start],
      b = trace.route[end],
      wire = a as Wire
    for (const points of [
      [a, b],
      ...ordinaryRunCandidates(a, b, trace.route.slice(start, end + 1)),
    ]) {
      const replacement = simplify(points)
      if (length(replacement) > prefix[end] - prefix[start] + 1e-7) {
        yield undefined
        continue
      }
      const key = `${start}:${end}:${replacement.map((p) => `${p.x},${p.y}`).join(";")}`
      if (seen.has(key)) continue
      seen.add(key)
      const added = replacement.length - (end - start + 1)
      const candidate: Trace = {
        ...trace,
        route: [
          ...trace.route.slice(0, start),
          ...replacement.map((p) => ({
            ...p,
            route_type: "wire" as const,
            layer: wire.layer,
            width: wire.width,
          })),
          ...trace.route.slice(end + 1),
        ],
        coupledSection: trace.coupledSection?.map((i) =>
          i >= end ? i + added : i,
        ) as [number, number] | undefined,
        curvedSegments: trace.curvedSegments
          ?.filter((i) => i <= start || i > end)
          .map((i) => (i > end ? i + added : i)),
      }
      yield routeAnglesAreConventional([candidate]) ? candidate : undefined
    }
  }
}

/** Cheap scratch shortcuts, round-robin across boundary/longest drivers first.
 * Clearance and coordinated length matching belong to the transaction caller;
 * no old routing solver or tuning pass is invoked. */
export function* skeletonShortcutCandidates(
  input: SimpleRouteJson,
  traces: Trace[],
  options: SkeletonShortcutOptions = {},
): Generator<Trace[] | undefined> {
  const generators = skeletonDriverPriorities(input, traces).map((index) => ({
    index,
    generator: traceShortcuts(traces[index], options.maxWindowsPerTrace ?? 32),
  }))
  let attempted = 0,
    active = true
  while (active && attempted < (options.maxCandidates ?? 256)) {
    active = false
    for (const { index, generator } of generators) {
      if (attempted >= (options.maxCandidates ?? 256)) return
      const next = generator.next()
      if (next.done) continue
      active = true
      attempted++
      if (!next.value) {
        yield undefined
        continue
      }
      const result = [...traces]
      result[index] = next.value
      yield result
    }
  }
}

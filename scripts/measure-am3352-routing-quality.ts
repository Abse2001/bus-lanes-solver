import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib"
import { distance } from "../lib/geometry"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"

const angleDifference = (a: number, b: number) =>
  Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180)
const heading = (a: Point, b: Point) =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
const aligned = (h: number) =>
  angleDifference(h, Math.round(h / 45) * 45) <= 0.2

/** Measure final pad-to-pad copper, not search paths. Curves are identified by
 * their emitted ending-vertex indices; normal segments must remain octilinear.
 * Detours/turns/jogs are reported without reference-layout-specific ceilings. */
export function measureAm3352RoutingQuality(
  input: SimpleRouteJson,
  traces: Trace[],
) {
  const issues: string[] = []
  const rows = traces.map((trace) => {
    const curved = new Set(trace.curvedSegments ?? [])
    const vias = trace.route.flatMap((p, i) =>
      p.route_type === "via" ? [i] : [],
    )
    const carrierStart = vias[0] + 1,
      carrierEnd = vias[1] - 1
    if (
      curved.size !== (trace.curvedSegments?.length ?? 0) ||
      [...curved].some((i) => {
        const a = trace.route[i - 1],
          b = trace.route[i]
        if (
          !Number.isInteger(i) ||
          i <= carrierStart ||
          i > carrierEnd ||
          a?.route_type !== "wire" ||
          b?.route_type !== "wire" ||
          a.layer !== b.layer
        )
          return true
        // A sampled arc chord can have an octilinear average heading.
        // The turn audit below checks actual curvature, not that heading.
        return false
      })
    )
      issues.push(
        `${trace.connection_name}: invalid curve ending-vertex indices`,
      )
    const section = trace.coupledSection
    if (
      section &&
      (section.length !== 2 ||
        !section.every(Number.isInteger) ||
        section[0] < carrierStart ||
        section[1] > carrierEnd ||
        section[0] >= section[1])
    )
      issues.push(`${trace.connection_name}: invalid coupled-section indices`)
    const runs: Array<Array<{ point: Wire; index: number }>> = []
    let planarLengthMm = 0,
      ordinaryTurns = 0,
      shortJogs = 0,
      acuteCorners = 0,
      sharpCurveCorners = 0,
      illegalOrdinaryCorners = 0,
      nonOctilinearOrdinarySegments = 0
    for (const [index, point] of trace.route.entries()) {
      if (point.route_type !== "wire") continue
      const previous = trace.route[index - 1]
      if (previous?.route_type === "wire" && previous.layer === point.layer) {
        planarLengthMm += distance(previous, point)
        if (distance(runs.at(-1)!.at(-1)!.point, point) > 1e-8)
          runs.at(-1)!.push({ point, index })
      } else runs.push([{ point, index }])
    }
    for (const run of runs) {
      const headings = run.slice(1).map(({ point, index }, i) => ({
        angle: heading(run[i].point, point),
        curved: curved.has(index),
      }))
      const turns = new Set<number>()
      for (const [i, segment] of headings.entries()) {
        if (!segment.curved && !aligned(segment.angle))
          nonOctilinearOrdinarySegments++
        if (!i) continue
        const previous = headings[i - 1]
        const turn = angleDifference(previous.angle, segment.angle)
        if (turn > 90.2) acuteCorners++
        if (previous.curved || segment.curved) {
          if (turn > 45.2) sharpCurveCorners++
          continue
        }
        if (turn > 0.2) turns.add(i)
        if (turn > 45.2) illegalOrdinaryCorners++
      }
      ordinaryTurns += turns.size
      for (let i = 1; i < run.length; i++)
        if (
          turns.has(i - 1) &&
          turns.has(i) &&
          distance(run[i - 1].point, run[i].point) < 0.25
        )
          shortJogs++
    }
    if (acuteCorners || illegalOrdinaryCorners || nonOctilinearOrdinarySegments)
      issues.push(`${trace.connection_name}: illegal ordinary routing geometry`)
    if (sharpCurveCorners)
      issues.push(`${trace.connection_name}: sharp curved routing geometry`)
    const straightDistanceMm = trace.route.length
      ? distance(trace.route[0], trace.route.at(-1)!)
      : 0
    return {
      connectionName: trace.connection_name,
      planarLengthMm,
      straightDistanceMm,
      detourRatio: straightDistanceMm
        ? planarLengthMm / straightDistanceMm
        : null,
      ordinaryTurns,
      shortJogs,
      acuteCorners,
      sharpCurveCorners,
      illegalOrdinaryCorners,
      nonOctilinearOrdinarySegments,
    }
  })
  const sum = (
    key: Exclude<keyof (typeof rows)[number], "connectionName" | "detourRatio">,
  ) => rows.reduce((n, row) => n + row[key], 0)
  const detours = rows.flatMap((r) =>
    r.detourRatio === null ? [] : [r.detourRatio],
  )
  const exteriorPairGaps = exteriorPairSpacingReports(input, traces)
  for (const pair of exteriorPairGaps) {
    if (!pair.matched)
      issues.push(
        `${pair.connectionNames.join("/")}: paired copper separates outside the native package fanout regions`,
      )
  }
  const pairGaps = sharedPairSpacingReports(input, traces)
  for (const pair of pairGaps) {
    if (!pair.matched)
      issues.push(
        `${pair.connectionNames.join("/")}: ${pair.sharedSectionPresent ? "paired shared section exceeds allowed separation" : "missing or invalid paired shared section"}`,
      )
  }

  return {
    signalCount: traces.length,
    totalPlanarLengthMm: sum("planarLengthMm"),
    maxDetourRatio: detours.length ? Math.max(...detours) : null,
    meanDetourRatio: detours.length
      ? detours.reduce((a, b) => a + b, 0) / detours.length
      : null,
    ordinaryTurns: sum("ordinaryTurns"),
    shortJogs: sum("shortJogs"),
    acuteCorners: sum("acuteCorners"),
    sharpCurveCorners: sum("sharpCurveCorners"),
    illegalOrdinaryCorners: sum("illegalOrdinaryCorners"),
    nonOctilinearOrdinarySegments: sum("nonOctilinearOrdinarySegments"),
    pairGaps,
    exteriorPairGaps,
    issues,
  }
}

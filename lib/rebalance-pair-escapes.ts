import { GridVisibilitySearch } from "./grid-visibility"
import { createTerminalViaClearanceChecker } from "./terminal-via-clearance"
import { VectorScene, fixedCopper, routeCopper } from "./vector-scene"
import { distance, length } from "./geometry"
import { fixedRouteLength, minimumLengthTargets } from "./route-lengths"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { tuneCoupledLengths } from "./tune-coupled-lengths"
import { alignCoupledSectionBoundaries } from "./align-coupled-section-boundaries"
import { BusLanesSolver } from "./bus-lanes-solver"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import type {
  Point,
  SimpleRouteJson,
  SolverOptions,
  Trace,
  Wire,
} from "./types"

const reverse = (trace: Trace): Trace => ({
  ...trace,
  route: trace.route.toReversed(),
  coupledSection: trace.coupledSection
    ? [
        trace.route.length - 1 - trace.coupledSection[1],
        trace.route.length - 1 - trace.coupledSection[0],
      ]
    : undefined,
  curvedSegments: trace.curvedSegments?.map((i) => trace.route.length - i),
})

/** Rebalance a pair whose external corridor is coupled but whose short package
 * approach cannot fit the remaining skew correction. Only caller-owned, newly
 * generated signal escapes may move. Fixed FanoutSolver copper stays immutable.
 * Search local pad-derived sites, cap surface escapes at 2 mm / 2.5 pad pitches,
 * and accept only a completely validated, matched and externally coupled set. */
export function* rebalancePairEscapes(
  input: SimpleRouteJson,
  traces: Trace[],
  generatedEscapes: Trace[],
  options: SolverOptions,
): Generator<
  void,
  { input: SimpleRouteJson; traces: Trace[]; escapes: Trace[] } | null
> {
  const targets = minimumLengthTargets(input, traces)
  const paired = new Set(
    input.differentialPairs?.flatMap((p) => p.connectionNames),
  )
  const generatedIds = new Set(generatedEscapes.map((t) => t.pcb_trace_id))
  const short = traces.filter(
    (t) =>
      paired.has(t.connection_name!) &&
      t.coupledSection &&
      (targets.get(t.connection_name!) ?? 0) >
        length(t.route) + fixedRouteLength(input, t.connection_name!) + 1e-7,
  )
  let attempts = 0
  for (const original of short)
    for (const end of [0, 1]) {
      const trace = end ? reverse(original) : original,
        name = trace.connection_name!,
        layer = (trace.route[0] as Wire).layer
      const escape = input.traces?.find(
        (t) =>
          generatedIds.has(t.pcb_trace_id) &&
          t.connection_name === name &&
          t.route.filter((p) => p.route_type === "via").length === 1 &&
          distance(t.route.at(-1)!, trace.route[0]) < 1e-7,
      )
      if (!escape) continue
      const pad = escape.route[0] as Wire,
        oldVia = escape.route.find((p) => p.route_type === "via")!
      if (pad.layer !== "top" || oldVia.from_layer !== "top") continue
      const owner = input.obstacles.find(
        (o) => o.componentId && distance(o.center, pad) < 1e-4,
      )
      if (!owner) continue
      const pads = input.obstacles.filter(
        (o) => o.componentId === owner.componentId,
      )
      const pitch = Math.min(
        ...pads.map((o) => distance(o.center, pad)).filter((d) => d > 1e-4),
      )
      if (!Number.isFinite(pitch)) continue
      const surfaceLimit = Math.min(2, 2.5 * pitch)
      const minX = Math.min(...pads.map((p) => p.center.x - p.width / 2)),
        maxX = Math.max(...pads.map((p) => p.center.x + p.width / 2))
      const minY = Math.min(...pads.map((p) => p.center.y - p.height / 2)),
        maxY = Math.max(...pads.map((p) => p.center.y + p.height / 2))
      const directions = [
        { x: -1, y: 0, d: pad.x - minX },
        { x: 1, y: 0, d: maxX - pad.x },
        { x: 0, y: -1, d: pad.y - minY },
        { x: 0, y: 1, d: maxY - pad.y },
      ]
        .sort((a, b) => a.d - b.d)
        .slice(0, 2)
      const held = traces.filter((t) => t !== original),
        connection = input.connections.find((c) => c.name === name)!
      const base = {
          ...input,
          traces: input.traces!.filter((t) => t !== escape),
        },
        fixed = [...fixedCopper(base), ...held.flatMap(routeCopper)]
      const width = (trace.route[0] as Wire).width
      function* find(
        a: Point,
        b: Point,
        carrier: string,
        maximum: number,
      ): Generator<void, Wire[] | null> {
        const localConnection = {
          ...connection,
          pointsToConnect: [
            { ...a, layer: carrier },
            { ...b, layer: carrier },
          ],
        }
        const scene = new VectorScene(base, localConnection, width, fixed)
        const search = new GridVisibilitySearch(
          scene,
          localConnection.pointsToConnect[0],
          localConnection.pointsToConnect[1],
          [],
          0,
          undefined,
          { maxLength: maximum, paretoLength: true, checkReachability: true },
        )
        try {
          let steps = 0
          while (!search.solved && !search.failed && steps++ < 4000) {
            search.step()
            yield
          }
          return search.solved
            ? reduceOrdinaryTurns(search.result, scene).map((p) => ({
                ...p,
                route_type: "wire",
                layer: carrier,
                width,
              }))
            : null
        } finally {
          search.cancel()
        }
      }
      for (const normal of directions)
        for (const outward of [1, 0.875, 1.125, 1.25, 1.5])
          for (const across of [1.125, 1, 0.875, 0.75, 1.25, 1.375, 1.5, 0.625])
            for (const sign of [-1, 1]) {
              if (++attempts > 192) return null
              const site = {
                x:
                  pad.x +
                  pitch * (normal.x * outward - normal.y * across * sign),
                y:
                  pad.y +
                  pitch * (normal.y * outward + normal.x * across * sign),
              }
              const via = { ...oldVia, ...site, to_layer: layer }
              const physical = Array.from(
                { length: input.layerCount },
                (_, i) =>
                  i === 0
                    ? "top"
                    : i === input.layerCount - 1
                      ? "bottom"
                      : `inner${i}`,
              )
              if (
                physical.some(
                  (carrier) =>
                    !new VectorScene(
                      base,
                      {
                        ...connection,
                        pointsToConnect: [
                          { ...site, layer: carrier },
                          { ...site, layer: carrier },
                        ],
                      },
                      via.via_diameter ?? 0.3,
                      fixed,
                    ).visible(site, site),
                )
              )
                continue
              let top = yield* find(pad, site, "top", surfaceLimit)
              const s = trace.coupledSection![0],
                prefix = yield* find(site, trace.route[s], layer, 4 * pitch)
              if (!top || !prefix) continue
              top = chamferOrdinaryCorners(
                {
                  ...base,
                  connections: [
                    {
                      ...connection,
                      pointsToConnect: [pad, { ...site, layer: "top" }],
                    },
                  ],
                },
                [{ ...escape, route: top }],
                fixed,
              )[0].route as Wire[]
              const replacement = {
                ...escape,
                route: [
                  ...top,
                  via,
                  { ...site, route_type: "wire" as const, layer, width },
                ],
              }
              const offset = prefix.length - 1 - s
              let changed: Trace = {
                ...trace,
                route: [...prefix.slice(0, -1), ...trace.route.slice(s)],
                coupledSection: trace.coupledSection!.map(
                  (i) => i + offset,
                ) as [number, number],
                curvedSegments: trace.curvedSegments
                  ?.filter((i) => i > s)
                  .map((i) => i + offset),
              }
              if (end) changed = reverse(changed)
              const local = {
                ...input,
                traces: input.traces!.map((t) =>
                  t === escape ? replacement : t,
                ),
                connections: input.connections.map((c) =>
                  c === connection
                    ? {
                        ...c,
                        pointsToConnect: [
                          changed.route[0] as Wire,
                          changed.route.at(-1)! as Wire,
                        ],
                      }
                    : c,
                ),
              }
              const total =
                length(changed.route) + fixedRouteLength(local, name)
              if (Math.abs(total - targets.get(name)!) > 1) continue
              // Smaller boundary bevels keep the independent approach correction inside
              // the native package region, rather than cutting into the coupled trunk.
              for (const trim of [0.75, 0.375, 1.5])
                try {
                  const candidate = alignCoupledSectionBoundaries(
                    local,
                    chamferOrdinaryCorners(
                      local,
                      traces.map((t) => (t === original ? changed : t)),
                      undefined,
                      trim,
                    ),
                  )
                  const tuned = tuneCoupledLengths(local, candidate, {
                    maxCandidates: 65536,
                    packMeanders: true,
                    packageOnlyPairTuning: true,
                  })
                  if (
                    tuned.some(
                      (t) =>
                        !createTerminalViaClearanceChecker(local, t, {
                          preserveExistingApproach: false,
                        })(t.route),
                    )
                  )
                    continue
                  const validator = BusLanesSolver.forValidation(
                    local,
                    tuned,
                    options,
                  )
                  try {
                    while (!validator.solved && !validator.failed) {
                      validator.step()
                      yield
                    }
                    const coupling = exteriorPairSpacingReports(local, tuned)
                    if (
                      validator.solved &&
                      coupling.length ===
                        (input.differentialPairs?.length ?? 0) &&
                      coupling.every((p) => p.applicable && p.matched)
                    )
                      return {
                        input: local,
                        traces: tuned,
                        escapes: generatedEscapes.map((t) =>
                          t.pcb_trace_id === escape.pcb_trace_id
                            ? replacement
                            : t,
                        ),
                      }
                  } finally {
                    if (!validator.solved && !validator.failed)
                      validator.tryFinalAcceptance()
                  }
                } catch {
                  yield
                }
            }
    }
  return null
}

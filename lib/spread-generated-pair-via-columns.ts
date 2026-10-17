import {
  getCopperLayerNames,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import { boardBoundaryReports } from "./board-boundary"
import { generatedEscapeHolesConflict } from "./expanded-signal-sites"
import { distance, length } from "./geometry"
import { signalWidth } from "./repair-bus-dogbones"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { surfaceBridgeSelfShorts } from "./route-surface-bridge"
import type {
  Connection,
  Point,
  SimpleRouteJson,
  Terminal,
  Trace,
  Wire,
} from "./types"
import { fixedCopper, VectorScene } from "./vector-scene"

const epsilon = 1e-7

/** Tentatively widen a generated pair's uncoupled package approach around a
 * native pad column. Supplied fanout is ineligible. A compensating horizontal
 * corner movement preserves each rail's exact length; native endpoints,
 * coupled sections, sampled curves and curve indices stay unchanged. Both
 * package ends are eligible, including an outermost native pad column.
 *
 * This bounded refinement belongs before ordinary signal negotiation. It
 * retains the original trace when the shape is unfamiliar, no useful native
 * via land becomes available, or any physical check rejects the proposal. */
export function spreadGeneratedPairViaColumns(
  native: SimpleRouteJson,
  generatedRetained: Trace[],
): Trace[] {
  const paired = new Set(
      native.differentialPairs?.flatMap((pair) => pair.connectionNames) ?? [],
    ),
    fixedIds = new Set(native.traces?.map((trace) => trace.pcb_trace_id) ?? []),
    suppliedOwners = new Set(
      native.traces?.flatMap((trace) => [
        trace.connection_name,
        trace.source_trace_id,
      ]) ?? [],
    ),
    diameter = native.minViaPadDiameter ?? 0.3,
    hole = native.minViaHoleDiameter ?? 0.15,
    clearance =
      native.minTraceToPadEdgeClearance ??
      native.defaultObstacleMargin ??
      0.075,
    result = [...generatedRetained]
  if (
    ![diameter, hole, native.minTraceWidth].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    hole > diameter ||
    !Number.isFinite(clearance) ||
    clearance < 0
  )
    return result

  for (let traceIndex = 0; traceIndex < result.length; traceIndex++) {
    for (const end of [0, 1]) {
      const trace = result[traceIndex],
        section = trace.coupledSection,
        connection = native.connections.find(
          (candidate) => candidate.name === trace.connection_name,
        )
      if (
        !connection ||
        !connection.pointsToConnect.length ||
        !paired.has(connection.name) ||
        fixedIds.has(trace.pcb_trace_id) ||
        suppliedOwners.has(connection.name) ||
        !section ||
        section.some((index) => !Number.isInteger(index)) ||
        section[0] < 0 ||
        section[0] >= section[1] ||
        section[1] >= trace.route.length
      )
        continue
      const first = end ? trace.route.at(-1)! : trace.route[0],
        pad = [...connection.pointsToConnect].sort(
          (a, b) => distance(a, first) - distance(b, first),
        )[0],
        body = native.obstacles.find(
          (obstacle) =>
            obstacle.componentId && distance(obstacle.center, pad) < epsilon,
        )
      if (!body) continue
      const field = native.obstacles.filter(
        (obstacle) => obstacle.componentId === body.componentId,
      )

      // Orthogonal transforms cover either package orientation and either side
      // of a native column without introducing a board-specific direction.
      let accepted = false
      for (const swap of [false, true]) {
        for (const sx of [1, -1]) {
          for (const sy of [1, -1]) {
            if (accepted) break
            const local = (point: Point): Point => ({
                x: sx * (swap ? point.y : point.x),
                y: sy * (swap ? point.x : point.y),
              }),
              world = (point: Point): Point =>
                swap
                  ? { x: sy * point.y, y: sx * point.x }
                  : { x: sx * point.x, y: sy * point.y },
              columns = field
                .map((obstacle) => local(obstacle.center).x)
                .sort((a, b) => a - b)
                .filter((value, index, values) =>
                  index ? value - values[index - 1] > epsilon : true,
                )
            const firstCorner = end ? section[1] + 2 : 2,
              lastCorner = end ? trace.route.length - 3 : section[0] - 2
            for (let i = firstCorner; i <= lastCorner && !accepted; i++) {
              for (const reverseLeg of [false, true]) {
                if (accepted) break
                const points = trace.route.slice(i - 2, i + 3)
                if (
                  points.some((point) => point.route_type !== "wire") ||
                  trace.curvedSegments?.some(
                    (index) => index >= i - 2 && index <= i + 2,
                  )
                )
                  continue
                const wires = (
                    reverseLeg ? points.toReversed() : points
                  ) as Wire[],
                  [a, h, p, q, r] = wires.map(local),
                  width = wires[2].width
                if (
                  !Number.isFinite(width) ||
                  width <= 0 ||
                  wires.some(
                    (wire) =>
                      wire.layer !== wires[2].layer ||
                      Math.abs(wire.width - width) > epsilon,
                  ) ||
                  Math.abs(p.x - q.x) > epsilon ||
                  p.y - q.y < diameter ||
                  Math.abs(a.y - h.y) > epsilon ||
                  h.x <= a.x ||
                  p.x <= h.x ||
                  q.x <= r.x ||
                  p.y >= h.y ||
                  r.y >= q.y ||
                  Math.abs(p.x - h.x - (h.y - p.y)) > epsilon ||
                  Math.abs(q.x - r.x - (q.y - r.y)) > epsilon
                )
                  continue
                const column = columns.filter((x) => x < p.x).at(-1),
                  right = columns.find((x) => x > p.x)
                if (column === undefined) continue
                const protectedPads = native.connections.flatMap((owner) =>
                  paired.has(owner.name)
                    ? []
                    : owner.pointsToConnect.flatMap((terminal) => {
                        const at = local(terminal)
                        return terminal.layer === wires[2].layer &&
                          Math.abs(at.x - column) < epsilon &&
                          at.y >= q.y &&
                          at.y <= p.y &&
                          field.some(
                            (obstacle) =>
                              distance(obstacle.center, terminal) < epsilon,
                          )
                          ? [{ connection: owner, terminal }]
                          : []
                      }),
                )
                if (!protectedPads.length) continue
                const required = diameter / 2 + width / 2 + clearance
                for (const extra of [width / 16, width / 32, width / 64, 0]) {
                  const target = column + required + extra,
                    delta = target - p.x
                  if (
                    delta <= epsilon ||
                    delta > width / 2 ||
                    (right !== undefined && target >= right) ||
                    Math.SQRT2 * delta >= h.x - a.x
                  )
                    continue
                  const proposal: Trace = {
                      ...trace,
                      route: trace.route.map((point) => ({ ...point })),
                    },
                    movedH = { x: h.x - Math.SQRT2 * delta, y: h.y },
                    movedP = {
                      x: target,
                      y: h.y - Math.abs(target - movedH.x),
                    },
                    movedQ = { x: target, y: q.y + delta }
                  if (movedP.y <= movedQ.y + epsilon) continue
                  Object.assign(
                    proposal.route[i + (reverseLeg ? 1 : -1)],
                    world(movedH),
                  )
                  Object.assign(proposal.route[i], world(movedP))
                  Object.assign(
                    proposal.route[i + (reverseLeg ? -1 : 1)],
                    world(movedQ),
                  )
                  const tentative = result.map((old, index) =>
                    index === traceIndex ? proposal : old,
                  )
                  if (
                    Math.abs(length(trace.route) - length(proposal.route)) >
                      1e-8 ||
                    !routeAnglesAreConventional([proposal]) ||
                    surfaceBridgeSelfShorts(native, connection, proposal) ||
                    !boardBoundaryReports(native, tentative).valid
                  )
                    continue
                  const input = {
                    ...native,
                    traces: [...(native.traces ?? []), ...tentative],
                  }
                  if (
                    !validateRoutedCopperDrc({
                      inputSrj: native,
                      routedSrj: input,
                      clearance,
                      allowBlindAndBuriedVias: false,
                    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid ||
                    !protectedPads.some(({ connection, terminal }) =>
                      hasNativeViaLand(
                        input,
                        connection,
                        terminal,
                        local,
                        world,
                        q.y,
                        p.y,
                        diameter,
                        hole,
                      ),
                    )
                  )
                    continue
                  result[traceIndex] = proposal
                  accepted = true
                  break
                }
              }
            }
          }
        }
      }
    }
  }
  return result
}

function hasNativeViaLand(
  input: SimpleRouteJson,
  connection: Connection,
  terminal: Terminal,
  local: (point: Point) => Point,
  world: (point: Point) => Point,
  low: number,
  high: number,
  diameter: number,
  hole: number,
) {
  const copper = fixedCopper(input),
    physical = getCopperLayerNames(input.layerCount),
    lands = physical.map(
      (layer) =>
        new VectorScene(
          input,
          {
            ...connection,
            pointsToConnect: connection.pointsToConnect.map((point) => ({
              ...point,
              layer,
            })),
          },
          diameter,
          copper,
        ),
    ),
    width = signalWidth(input, connection),
    approach = new VectorScene(input, connection, width, copper),
    pad = local(terminal)
  for (const direction of [-1, 1]) {
    const y = pad.y + direction * width
    if (y < low || y > high) continue
    const at = world({ x: pad.x, y }),
      via: Trace = {
        type: "pcb_trace",
        pcb_trace_id: "tentative_native_column_via",
        connection_name: connection.name,
        route: [
          {
            ...at,
            route_type: "via",
            from_layer: physical[0],
            to_layer: physical.at(-1)!,
            layers: physical,
            via_diameter: diameter,
            via_hole_diameter: hole,
          },
        ],
      }
    if (
      lands.every((scene) => scene.visible(at, at)) &&
      approach.visible(terminal, at) &&
      !input.connections.some((owner) =>
        owner.pointsToConnect.some((point) => distance(point, at) <= 1e-6),
      ) &&
      !generatedEscapeHolesConflict(input, [via], input.traces ?? [])
    )
      return true
  }
  return false
}

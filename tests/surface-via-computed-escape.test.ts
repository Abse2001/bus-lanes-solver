import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { distance, length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { surfaceBridgeSelfShorts } from "../lib/route-surface-bridge"
import { routeSurfaceViaAttachments } from "../lib/route-surface-via-attachments"
import type { SimpleRouteJson, Trace, Via, Wire } from "../lib/types"
import { fixedCopper, VectorScene } from "../lib/vector-scene"
import { connectors } from "../lib/vector-visibility"

const wire = (x: number, y: number, layer = "top"): Wire => ({
  x,
  y,
  layer,
  width: 0.1,
  route_type: "wire",
})

function finish<T>(search: Generator<void, T>): T {
  let result = search.next(),
    yields = 0
  while (!result.done && yields++ < 10000) result = search.next()
  if (!result.done) throw Error("Computed escape search exceeded its bound")
  return result.value
}

function fixture() {
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minBoardEdgeClearance: 0.05,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
    allowBlindAndBuriedVias: false,
    bounds: { minX: -3, maxX: 4, minY: -1.2, maxY: 2.5 },
    connections: [
      {
        name: "signal",
        source_trace_id: "native-signal",
        pointsToConnect: [
          { x: -2, y: 0, layer: "top", pcb_port_id: "cpu-native" },
          { x: 2, y: 0, layer: "top", pcb_port_id: "ram-native" },
        ],
      },
      {
        name: "power",
        pointsToConnect: [
          { x: -2.7, y: -0.8, layer: "top" },
          { x: -2.7, y: -0.4, layer: "top" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "immutable-power-fanout",
        connection_name: "power",
        route: [wire(-2.7, -0.8), wire(-2.7, -0.4)],
      },
    ],
    obstacles: [
      {
        type: "rect",
        center: { x: 2.5, y: 0.8 },
        width: 1.4,
        height: 0.4,
        layers: ["top"],
        connectedTo: ["top-obstruction"],
      },
      // No Bottom landing lies within the default local reach of RAM. A
      // previously computed winding escape reaches the clear site above it.
      {
        type: "rect",
        center: { x: 2, y: 0 },
        width: 2.4,
        height: 1.4,
        layers: ["bottom"],
        connectedTo: ["bottom-obstruction"],
      },
    ],
  }
  const via: Via = {
    x: 3,
    y: 1.6,
    route_type: "via",
    from_layer: "top",
    to_layer: "bottom",
    layers: ["top", "inner1", "inner2", "bottom"],
    via_diameter: 0.3,
    via_hole_diameter: 0.15,
  }
  const escape: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "computed-winding-ram",
    connection_name: "signal",
    source_trace_id: "native-signal",
    route: [
      { ...input.connections[0].pointsToConnect[1], ...wire(2, 0) },
      wire(1.6, 0),
      wire(1.4, 0.2),
      wire(1.4, 1.2),
      wire(1.6, 1.4),
      wire(2.8, 1.4),
      wire(3, 1.6),
      via,
      wire(3, 1.6, "bottom"),
    ],
  }
  return { input, escape }
}

const options = { gridStep: 0.1, maxVias: 4, maxExpansions: 30000 }

test("an existing winding native escape joins a newly computed opposite-end handoff", () => {
  const { input, escape } = fixture(),
    beforeInput = structuredClone(input),
    beforeEscape = structuredClone(escape),
    connection = input.connections[0],
    scene = new VectorScene(input, connection, 0.1, fixedCopper(input)),
    native = connection.pointsToConnect[1],
    site = escape.route.at(-1)!
  const analytic = connectors(native, site)
  expect(analytic).toHaveLength(5)
  expect(analytic.every((path) => !scene.pathVisible(path))).toBe(true)
  expect(scene.pathVisible(escape.route.slice(0, -2))).toBe(true)
  expect(routeAnglesAreConventional([escape])).toBe(true)
  expect(length(escape.route)).toBeGreaterThan(0.65)
  expect(
    finish(routeSurfaceViaAttachments(input, connection, options)),
  ).toBeNull()

  const result = finish(
    routeSurfaceViaAttachments(input, connection, {
      ...options,
      candidateEscapes: [escape],
    }),
  )
  expect(result).toBeTruthy()
  if (!result) throw Error("Expected reuse of the winding RAM escape")
  const retained = result.escapes.find(
      (candidate) => distance(candidate.route[0], native) < 1e-8,
    ),
    joined = joinSignalEscapes(result.carrier, result.escapes),
    vias = joined.route.filter(
      (point): point is Via => point.route_type === "via",
    )
  expect(retained).toBeTruthy()
  expect(retained!.route.slice(0, escape.route.length)).toEqual(escape.route)
  expect(
    result.carrier.route.every(
      (point) => point.route_type === "wire" && point.layer === "bottom",
    ),
  ).toBe(true)
  expect(vias).toHaveLength(2)
  expect(vias.every((point) => point.layers?.length === 4)).toBe(true)
  expect(joined.route[0]).toMatchObject(connection.pointsToConnect[0])
  expect(joined.route.at(-1)).toMatchObject(native)
  expect(surfaceBridgeSelfShorts(input, connection, joined)).toBe(false)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [...input.traces!, joined] },
      clearance: 0.05,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
  expect(input).toEqual(beforeInput)
  expect(escape).toEqual(beforeEscape)
})

test("supplied computed escape candidates remain subject to hard copper clearance", () => {
  const { input, escape } = fixture()
  input.obstacles.push({
    type: "rect",
    center: { x: 1.4, y: 0.7 },
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: ["new-hard-copper"],
  })
  const before = structuredClone({ input, escape })
  expect(
    finish(
      routeSurfaceViaAttachments(input, input.connections[0], {
        ...options,
        candidateEscapes: [escape],
      }),
    ),
  ).toBeNull()
  expect({ input, escape }).toEqual(before)
})

test("computed candidates cannot bypass native terminals, wire widths, or manufactured via rules", () => {
  for (const invalidate of [
    (escape: Trace) => {
      escape.route[0].x += 0.01
    },
    (escape: Trace) => {
      ;(escape.route[2] as Wire).width = 0.09
    },
    (escape: Trace) => {
      ;(escape.route[7] as Via).via_diameter = 0.29
    },
    (escape: Trace) => {
      ;(escape.route[7] as Via).via_hole_diameter = 0.14
    },
    (escape: Trace) => {
      ;(escape.route[7] as Via).layers = ["top", "bottom"]
    },
    (escape: Trace) => {
      ;(escape.route[7] as Via).to_layer = "inner2"
    },
    (escape: Trace) => {
      escape.route.at(-1)!.x += 0.01
    },
  ]) {
    const { input, escape } = fixture()
    invalidate(escape)
    const before = structuredClone({ input, escape })
    expect(
      finish(
        routeSurfaceViaAttachments(input, input.connections[0], {
          ...options,
          candidateEscapes: [escape],
        }),
      ),
    ).toBeNull()
    expect({ input, escape }).toEqual(before)
  }
})

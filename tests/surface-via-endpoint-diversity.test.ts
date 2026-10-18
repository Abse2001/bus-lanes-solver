import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { distance } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { routeSurfaceViaAttachments } from "../lib/route-surface-via-attachments"
import type { SimpleRouteJson, Via } from "../lib/types"

test("bounded endpoint domains include farther interstices outside a caged nearest-site pocket", () => {
  const input: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: 0.02,
      minTraceToPadEdgeClearance: 0.01,
      minViaPadDiameter: 0.1,
      minViaHoleDiameter: 0.05,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.4,
      bounds: { minX: -1, maxX: 4, minY: -1, maxY: 1 },
      connections: [
        {
          name: "signal",
          pointsToConnect: [
            { x: 0, y: 0, layer: "top" },
            { x: 3, y: 0, layer: "top" },
          ],
        },
      ],
      obstacles: [
        {
          type: "rect",
          center: { x: 0.6, y: 0 },
          width: 0.05,
          height: 2,
          layers: ["top"],
          connectedTo: ["top-wall"],
        },
        ...[-0.3, 0.3].flatMap((coordinate) => [
          {
            type: "rect",
            center: { x: coordinate, y: 0 },
            width: 0.05,
            height: 0.65,
            layers: ["bottom"],
            connectedTo: ["pocket-wall"],
          },
          {
            type: "rect",
            center: { x: 0, y: coordinate },
            width: 0.65,
            height: 0.05,
            layers: ["bottom"],
            connectedTo: ["pocket-wall"],
          },
        ]),
      ],
    },
    before = structuredClone(input),
    connection = input.connections[0]
  // All six nearest .1-grid sites lie inside the closed Bottom pocket. The
  // drill-spacing rule also forbids an extra return barrel inside that pocket;
  // the first manufactured site must instead lie beyond its enclosing wall.
  const search = routeSurfaceViaAttachments(input, connection, {
    gridStep: 0.1,
    maxVias: 4,
    maxEndpointCandidates: 6,
    maxAttachmentPairs: 16,
    maxExpansions: 10000,
  })
  let step = search.next(),
    yields = 0
  while (!step.done && yields++ < 1000) step = search.next()
  expect(step.done).toBe(true)
  expect(step.value).toBeTruthy()
  const result = step.value!,
    joined = joinSignalEscapes(result.carrier, result.escapes),
    vias = joined.route.filter(
      (point): point is Via => point.route_type === "via",
    )
  expect(vias).toHaveLength(2)
  expect(distance(vias[0], connection.pointsToConnect[0])).toBeGreaterThan(0.3)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [joined] },
      clearance: 0.01,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
  expect(input).toEqual(before)
})

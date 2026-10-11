import { expect, test } from "bun:test"
import { reserveBusPackageExits } from "../lib/reserve-bus-package-exits"
import type { Obstacle, SimpleRouteJson, Trace } from "../lib/types"

function inputWithNativeOwners(): SimpleRouteJson {
  const names = ["DQS", "DQSn", "D0", "D1"]
  const pad = (
    component: string,
    name: string,
    x: number,
    y: number,
  ): Obstacle & { circuitJsonMetadata: { pcb_port_id: string } } => ({
    componentId: component,
    center: { x, y },
    width: 0.4,
    height: 0.4,
    layers: ["top"],
    connectedTo: [name, `${component}_${name}`],
    circuitJsonMetadata: { pcb_port_id: `${component}_${name}` },
  })
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
    obstacles: [
      ...names.flatMap((name, i) => [
        pad("cpu", name, [1, 2, 8, 9][i], 0),
        pad("ram", name, [1, 2, 8, 9][i], -10),
      ]),
      pad("cpu", "NC0", 0, 0),
      pad("cpu", "NC1", 10, 10),
      pad("ram", "NC0", 0, -10),
      pad("ram", "NC1", 10, -12),
    ],
    connections: names.map((name, i) => ({
      name,
      pointsToConnect: [
        { x: [1, 2, 8, 9][i], y: 0, layer: "top", pcb_port_id: `cpu_${name}` },
        {
          x: [1, 2, 8, 9][i],
          y: -10,
          layer: "top",
          pcb_port_id: `ram_${name}`,
        },
      ],
    })),
    buses: [{ busId: "byte", connectionNames: names, maxLengthSkew: 0.635 }],
    differentialPairs: [
      {
        connectionNames: ["DQS", "DQSn"],
        traceGap: 0.12,
        lengthTolerance: 0.127,
      },
    ],
  }
}

function nearbyBypass(): Obstacle {
  return {
    componentId: "bypass",
    center: { x: 10.5, y: -1 },
    width: 0.4,
    height: 0.4,
    layers: ["bottom"],
    connectedTo: ["GND"],
  }
}

function withGeneratedHandoffs(native: SimpleRouteJson): SimpleRouteJson {
  const traces: Trace[] = native.connections.flatMap((c) =>
    c.pointsToConnect.map((p, index): Trace => {
      const site = { x: p.x + 0.4, y: p.y + (index ? 0.4 : -0.4) }
      return {
        type: "pcb_trace",
        pcb_trace_id: `dogbone_${c.name}_${index}`,
        connection_name: c.name,
        route: [
          { ...p, route_type: "wire", width: 0.1 },
          { ...site, route_type: "wire", layer: "top", width: 0.1 },
          {
            ...site,
            route_type: "via",
            from_layer: "top",
            to_layer: "bottom",
            layers: ["top", "inner1", "inner2", "bottom"],
          },
          { ...site, route_type: "wire", layer: "bottom", width: 0.1 },
        ],
      }
    }),
  )
  return {
    ...native,
    traces,
    connections: native.connections.map((c) => ({
      ...c,
      pointsToConnect: c.pointsToConnect.map((p, index) => ({
        x: p.x + 0.4,
        y: p.y + (index ? 0.4 : -0.4),
        layer: "bottom",
      })),
    })),
  }
}

test("nearby bypass pads cannot steal native package exit reservations", () => {
  const input = inputWithNativeOwners()
  const baseline = reserveBusPackageExits(input, input.differentialPairs![0])
  const withBypass = {
    ...input,
    obstacles: [...input.obstacles, nearbyBypass()],
  }
  const before = structuredClone(withBypass)
  expect(baseline).toHaveLength(4)
  expect(
    reserveBusPackageExits(withBypass, input.differentialPairs![0]),
  ).toEqual(baseline)
  expect(withBypass).toEqual(before)
  expect(baseline.filter((r) => r.a.y === 0).every((r) => r.b.y < r.a.y)).toBe(
    true,
  )
})

test("generated handoffs recover native ownership from their one-via approaches", () => {
  const native = inputWithNativeOwners()
  // Move the RAM close enough that a CPU edge handoff is nearer the RAM's
  // package center. Its one-via approach still identifies the CPU unambiguously.
  for (const pad of native.obstacles)
    if (pad.componentId === "ram") pad.center.y += 6
  for (const connection of native.connections)
    connection.pointsToConnect[1].y += 6
  const input = withGeneratedHandoffs(native)
  const pair = input.differentialPairs![0]
  const baseline = reserveBusPackageExits(input, pair)
  const withBypass = {
    ...input,
    obstacles: [...input.obstacles, nearbyBypass()],
  }
  const before = structuredClone(withBypass)
  expect(reserveBusPackageExits(withBypass, pair)).toEqual(baseline)
  expect(withBypass).toEqual(before)
  expect(baseline).toHaveLength(4)
})

test("physical port metadata takes priority over repeated net aliases", () => {
  const input = inputWithNativeOwners()
  const baseline = reserveBusPackageExits(input, input.differentialPairs![0])
  const impostor = {
    ...nearbyBypass(),
    // Captures can carry every endpoint's alias on the whole net. Geometry
    // and those aliases must not override the terminal's physical pcb_port_id.
    center: { x: 9, y: 0 },
    connectedTo: ["D0", "D1", "cpu_D0", "cpu_D1"],
  }
  expect(
    reserveBusPackageExits(
      { ...input, obstacles: [...input.obstacles, impostor] },
      input.differentialPairs![0],
    ),
  ).toEqual(baseline)
})

test("mixed-carrier reservations retain each ordinary terminal's physical layer", () => {
  const input = inputWithNativeOwners()
  const original = reserveBusPackageExits(input, input.differentialPairs![0])
  for (const connection of input.connections.slice(2))
    for (const point of connection.pointsToConnect) point.layer = "bottom"
  const before = structuredClone(input)
  const reservations = reserveBusPackageExits(
    input,
    input.differentialPairs![0],
  )
  expect(reservations).toHaveLength(4)
  expect(
    reservations.every((reservation) => reservation.layer === "bottom"),
  ).toBe(true)
  expect(
    reservations.map((reservation) => ({ ...reservation, layer: "top" })),
  ).toEqual(original)
  expect(input).toEqual(before)
})

test("exit depth on another carrier cannot suppress a legal ordinary reservation", () => {
  const input = inputWithNativeOwners()
  input.connections[2].pointsToConnect[0].layer = "bottom"
  input.connections[2].pointsToConnect[0].y -= 0.3
  const reservations = reserveBusPackageExits(
    input,
    input.differentialPairs![0],
  )
  expect(
    reservations.find(
      (reservation) =>
        reservation.owners.includes("D0") && reservation.a.y === -0.3,
    )?.layer,
  ).toBe("bottom")
  expect(
    reservations.find(
      (reservation) =>
        reservation.owners.includes("D1") && reservation.a.y === 0,
    )?.layer,
  ).toBe("top")
})

test("a same-XY pad on the opposite layer cannot steal generated approach ownership", () => {
  const input = withGeneratedHandoffs(inputWithNativeOwners())
  // Fanout adapters can strip port metadata from generated wire vertices.
  for (const trace of input.traces!)
    delete (trace.route[0] as { pcb_port_id?: string }).pcb_port_id
  const baseline = reserveBusPackageExits(input, input.differentialPairs![0])
  const oppositeLayer: Obstacle = {
    ...nearbyBypass(),
    center: { x: 9, y: 0 },
    connectedTo: ["D1", "cpu_D1"],
  }
  const withOppositeLayer = {
    ...input,
    // The distractor must precede the real CPU pad to expose first-match errors.
    obstacles: [oppositeLayer, ...input.obstacles],
  }
  const before = structuredClone(withOppositeLayer)
  expect(
    reserveBusPackageExits(withOppositeLayer, input.differentialPairs![0]),
  ).toEqual(baseline)
  expect(withOppositeLayer).toEqual(before)
})

import { expect, spyOn, test } from "bun:test"
import { BusLanesPipelineSolver, BusLanesSolver } from "../lib"
import { backwardFacingPackageTerminals } from "../lib/backward-facing-package-terminals"
import { loadAm3352Sample } from "../scripts/am3352-samples"
import type { SimpleRouteJson, Point } from "../lib/types"

function preparedMatchingInput(input: SimpleRouteJson) {
  let captured: SimpleRouteJson | undefined
  const childStep = spyOn(BusLanesSolver.prototype, "_step").mockImplementation(
    function (this: BusLanesSolver) {
      captured = structuredClone(this.input)
      this.failed = true
      this.error = "Capture the prepared terminal geometry"
    },
  )
  try {
    // Inspect the common initial dogbone geometry before dense routing chooses
    // a joint package strategy or reconsiders fresh signal sites.
    new BusLanesPipelineSolver(input, { denseSearch: false }).step()
    const matchingNames = new Set([
      ...(captured!.buses ?? []).flatMap((bus) => bus.connectionNames),
      ...(captured!.differentialPairs ?? []).flatMap(
        (pair) => pair.connectionNames,
      ),
    ])
    return {
      ...captured!,
      connections: captured!.connections.filter((c) =>
        matchingNames.has(c.name),
      ),
    }
  } finally {
    childStep.mockRestore()
  }
}

test("package-facing classification comes from each native prepared AM3352 phase", async () => {
  for (const [name, expected] of [
    ["control", false],
    ["right", true],
    ["left", true],
    ["above", true],
  ] as const) {
    const { input } = await loadAm3352Sample(name)
    const matching = preparedMatchingInput(input)
    expect(matching.connections).toHaveLength(24)
    const before = structuredClone(matching)
    expect(backwardFacingPackageTerminals(matching)).toBe(expected)
    expect(matching).toEqual(before)
  }
})

test("completed AM62L boundary fanouts face their connected package in every placement", async () => {
  for (const name of [
    "ddr_left_io_right",
    "ddr_right_io_left",
    "ddr_top_io_bottom",
    "ddr_bottom_io_top",
  ]) {
    const input = await Bun.file(
      `tests/fixtures/two-fanouts/${name}.json`,
    ).json()
    expect(backwardFacingPackageTerminals(input)).toBe(false)
  }
})

function genericInput(
  sourceRear: boolean,
  remoteRear: boolean,
): SimpleRouteJson {
  const points = [0, 1].map((index) => [
    { x: sourceRear ? -1 : 1, y: index - 0.5, layer: "inner1" },
    { x: remoteRear ? 11 : 9, y: index - 0.5, layer: "inner1" },
  ])
  return {
    bounds: { minX: -5, maxX: 15, minY: -5, maxY: 5 },
    layerCount: 4,
    minTraceWidth: 0.1,
    connections: points.map((pointsToConnect, index) => ({
      name: `signal_${index}`,
      pointsToConnect,
    })),
    obstacles: [0, 10].flatMap((x, side) => [
      ...[-2, 2].flatMap((dx) =>
        [-2, 2].map((y) => ({
          componentId: `package_${side}`,
          center: { x: x + dx, y },
          width: 0.4,
          height: 0.2,
          ccwRotationDegrees: 0,
          layers: ["top"],
          connectedTo: [],
        })),
      ),
      ...points.map((terminals, index) => ({
        componentId: `package_${side}`,
        center: { x: terminals[side].x, y: terminals[side].y },
        width: 0.4,
        height: 0.2,
        ccwRotationDegrees: 0,
        layers: ["top"],
        connectedTo: [`signal_${index}`],
      })),
    ]),
  }
}

test("classification follows geometry under rotation, reflection, translation, and terminal reordering", () => {
  for (const sourceRear of [false, true])
    for (const remoteRear of [false, true]) {
      const input = genericInput(sourceRear, remoteRear)
      for (const angle of [0, 45, 90, 135, 180, 270])
        for (const reflection of [-1, 1]) {
          const radians = (angle * Math.PI) / 180
          const transform = (point: Point) => ({
            x:
              point.x * reflection * Math.cos(radians) -
              point.y * Math.sin(radians) +
              42,
            y:
              point.x * reflection * Math.sin(radians) +
              point.y * Math.cos(radians) -
              21,
          })
          const changed = structuredClone(input)
          for (const pad of changed.obstacles) {
            pad.center = transform(pad.center)
            pad.ccwRotationDegrees = angle
            pad.componentId = `renamed_${pad.componentId}`
          }
          for (const connection of changed.connections) {
            connection.pointsToConnect = connection.pointsToConnect
              .map((point) => ({ ...point, ...transform(point) }))
              .reverse()
          }
          expect(backwardFacingPackageTerminals(changed)).toBe(
            sourceRear || remoteRear,
          )
        }
    }
})

test("unowned terminals cannot be assigned to a package by proximity alone", () => {
  const input = genericInput(true, true)
  for (const pad of input.obstacles) pad.connectedTo = []
  expect(backwardFacingPackageTerminals(input)).toBe(false)
})

test("native physical ports retain package ownership beyond the midpoint despite whole-net aliases", () => {
  const input = genericInput(false, false)
  for (const [index, connection] of input.connections.entries()) {
    const ports = [`cpu_native_${index}`, `ram_native_${index}`]
    for (const pad of input.obstacles.filter((pad) =>
      pad.connectedTo.includes(connection.name),
    )) {
      const port = ports[pad.componentId === "package_0" ? 0 : 1]
      Object.assign(pad, { circuitJsonMetadata: { pcb_port_id: port } })
      // Electrical aliases must not override the native pad's physical owner.
      pad.connectedTo.push(...ports)
    }
    const [source, remote] = connection.pointsToConnect
    source.pcb_port_id = ports[0]
    source.x = 6
    remote.pcb_port_id = ports[1]
    remote.x = 11
  }
  const before = structuredClone(input)
  // The CPU-owned handoff at x=6 is closer to RAM's x=9 pad than its own x=1
  // pad. RAM's x=11 handoff is behind its center at x=10 relative to the CPU.
  expect(backwardFacingPackageTerminals(input)).toBe(true)
  expect(input).toEqual(before)
  for (const connection of input.connections)
    connection.pointsToConnect.reverse()
  expect(backwardFacingPackageTerminals(input)).toBe(true)
  for (const connection of input.connections)
    connection.pointsToConnect[0].x = 9
  expect(backwardFacingPackageTerminals(input)).toBe(false)
})

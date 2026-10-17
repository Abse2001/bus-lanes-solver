import { expect, test } from "bun:test"
import { reserveBusPackageExits } from "../lib/reserve-bus-package-exits"
import type { SimpleRouteJson } from "../lib"
import { distance } from "../lib/geometry"

function packageBus(): SimpleRouteJson {
  const pads = [
    ["P", -4.8, 1, "top"],
    ["N", -4.8, -1, "top"],
    ["west", -4.8, 3, "top"],
    ["north", -1, 4.8, "top"],
    ["south", -1, -4.8, "top"],
    ["east", 4.8, 0, "top"],
    ["other-plane", -4.8, -3, "bottom"],
  ] as const
  return {
    layerCount: 4,
    minTraceWidth: 0.2,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -20, maxX: 20, minY: -10, maxY: 10 },
    obstacles: [-10, 10].flatMap((center, component) =>
      [-4.9, 4.9].flatMap((x) =>
        [-4.9, 4.9].map((y) => ({
          center: { x: center + x, y },
          width: 0.2,
          height: 0.2,
          componentId: String(component),
          layers: ["top"],
          connectedTo: [],
        })),
      ),
    ),
    connections: pads.map(([name, x, y, layer]) => ({
      name,
      pointsToConnect: [-10, 10].map((center) => ({
        x: center + x,
        y,
        layer,
      })),
    })),
    buses: [{ busId: "DATA", connectionNames: pads.map(([name]) => name) }],
    differentialPairs: [{ connectionNames: ["P", "N"], lengthTolerance: 0.1 }],
  }
}

test("pair guides reserve only the ordinary exits sharing each face and signal layer", () => {
  const input = packageBus()
  // The first bus member is deliberately on another plane.
  input.connections.unshift(input.connections.pop()!)
  const guides = reserveBusPackageExits(input, input.differentialPairs![0])
  expect(guides).toHaveLength(8)
  expect(guides.every((guide) => guide.layer === "top")).toBe(true)
  expect(guides.some((guide) => guide.owners.includes("other-plane"))).toBe(
    false,
  )
  for (const guide of guides)
    expect(distance(guide.a, guide.b)).toBeCloseTo(0.3, 10)
})

test("a standalone pair reserves all bus exits without subtracting pair members from demand", () => {
  const input = packageBus()
  input.buses![0].connectionNames = ["west", "north", "south", "east"]
  const guides = reserveBusPackageExits(input, input.differentialPairs![0])
  expect(guides).toHaveLength(8)
  for (const guide of guides)
    expect(distance(guide.a, guide.b)).toBeCloseTo(0.3, 10)
})

test("native BGA ownership wins over closer support-part centers when counting face demand", () => {
  const input = packageBus()
  const secondWest = {
    name: "west-second",
    pointsToConnect: [-10, 10].map((center) => ({
      x: center - 4.8,
      y: 2,
      layer: "top",
    })),
  }
  input.connections.push(secondWest)
  input.buses![0].connectionNames.push(secondWest.name)
  for (const connection of input.connections)
    connection.pointsToConnect.forEach((point, end) => {
      input.obstacles.push({
        center: { x: point.x, y: point.y },
        width: 0.2,
        height: 0.2,
        componentId: String(end),
        layers: ["top"],
        connectedTo: [connection.name],
      })
    })
  input.obstacles.unshift({
    center: { x: -14.8, y: 3 },
    width: 0.2,
    height: 0.2,
    componentId: "decoupler",
    layers: ["bottom"],
    connectedTo: [],
  })
  const guides = reserveBusPackageExits(input, input.differentialPairs![0])
  const west = guides.filter((guide) => guide.owners[0].startsWith("west"))
  expect(west).toHaveLength(4)
  for (const guide of west)
    expect(distance(guide.a, guide.b)).toBeCloseTo(0.6, 10)
})

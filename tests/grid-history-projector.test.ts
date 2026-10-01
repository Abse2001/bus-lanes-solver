import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  GridHistoryProjector,
  GridVisibilitySearch,
} from "../lib/grid-visibility"
import { VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson } from "../lib/types"

const baseline = [
  [
    160801,
    28,
    "912ebab8a9f6ef25a5a5fcc21a02dd67283cda080d2e04e3e13f772e24fe52b4",
  ],
  [
    7290,
    60,
    "87db9fc366285382b5672400b679b75bdcc0d6e4f29952481fa03a9c6a5dcebf",
  ],
  [
    160801,
    349,
    "91f39a1c2b7624ddffed64ab0bc53dd9ef42697ee7420847dbfce22561fef22a",
  ],
  [
    7290,
    711,
    "41dad4e31342354f260f6dc54b47f388a26279c684421595f161586a0cefa7cf",
  ],
  [
    14168,
    118,
    "178a41621987b1952789bbecf782253d54a42512dc6680b0f1c8d35c7ffc2f36",
  ],
  [
    7290,
    60,
    "87db9fc366285382b5672400b679b75bdcc0d6e4f29952481fa03a9c6a5dcebf",
  ],
  [
    14168,
    1385,
    "b6dfd58f440bac745153486d81e573557ba39f5da7b3deaf5051d08445598030",
  ],
  [
    7290,
    711,
    "41dad4e31342354f260f6dc54b47f388a26279c684421595f161586a0cefa7cf",
  ],
] as const

function makeScene(packageGrid: boolean) {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
    obstacles: packageGrid
      ? [
          {
            componentId: "U1",
            center: { x: 0, y: 0 },
            width: 0.3,
            height: 0.3,
            layers: ["top"],
            connectedTo: [],
          },
        ]
      : [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: -2, y: 0, layer: "top" },
          { x: 2, y: 0, layer: "top" },
        ],
      },
    ],
  }
  return new VectorScene(input, input.connections[0], 0.1, [])
}

// Hashes were captured from the original GridVisibilitySearch before extracting
// the projector. They cover both package bounds and explicit fractional grids.
test("history projection preserves grid dimensions and exact congestion cells", () => {
  let fixture = 0
  for (const packageGrid of [false, true])
    for (const wholeSegments of [false, true])
      for (const overridden of [false, true]) {
        const scene = makeScene(packageGrid)
        const grid = overridden
          ? {
              step: 0.07,
              bounds: { minX: -2.31, maxX: 3.27, minY: -3.54, maxY: 2.66 },
            }
          : undefined
        const projector = new GridHistoryProjector(scene, grid)
        const search = new GridVisibilitySearch(
          scene,
          scene.connection.pointsToConnect[0],
          scene.connection.pointsToConnect[1],
          [],
          4,
          undefined,
          grid,
        )
        const history = new Float32Array(projector.cellCount)
        const original = new Float32Array(search.cellCount)
        for (const [target, data] of [
          [projector, history],
          [search, original],
        ] as const)
          target.penalizeIntersection(
            data,
            { x: -1.13, y: -0.57 },
            { x: 1.32, y: 1.17 },
            { x: 0.88, y: -1.27 },
            { x: -0.61, y: 1.48 },
            0.27,
            wholeSegments,
          )
        const [cells, touched, hash] = baseline[fixture++]
        expect(projector.cellCount).toBe(cells)
        expect(history.filter((x) => x).length).toBe(touched)
        expect(
          createHash("sha256")
            .update(new Uint8Array(history.buffer))
            .digest("hex"),
        ).toBe(hash)
        expect(history).toEqual(original)
      }
})

test("a history-only projector does not rasterize copper or attach endpoints", () => {
  const scene = makeScene(true)
  Object.defineProperty(scene, "copper", {
    get() {
      throw Error("History projection must not rasterize copper")
    },
  })
  scene.pathVisible = () => {
    throw Error("History projection must not attach endpoints")
  }
  const projector = new GridHistoryProjector(scene)
  expect(projector.cellCount).toBe(14168)
})

import { expect, test } from "bun:test"
import { sharedStraightSection } from "../lib/shared-straight-section"
import { length } from "../lib/geometry"
import type { Trace } from "../lib/types"

const rail = (
  name: string,
  points: number[][],
  section: [number, number],
): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  coupledSection: section,
  route: points.map(([x, y]) => ({
    x,
    y,
    layer: "bottom",
    width: 0.1,
    route_type: "wire",
  })),
})

test("unequal approach vertices retain copper while selecting the true parallel overlap", () => {
  const rails = [
    rail(
      "p",
      [
        [-1, -1],
        [0, 0],
        [0, 10],
        [1, 11],
      ],
      [0, 3],
    ),
    rail(
      "n",
      [
        [0.22, 1],
        [0.22, 9],
        [2.22, 11],
      ],
      [0, 2],
    ),
  ]
  const result = sharedStraightSection(rails, 0.22)!
  expect(result).toHaveLength(2)
  for (let i = 0; i < 2; i++) {
    expect(length(result[i].route)).toBeCloseTo(length(rails[i].route), 10)
    expect(result[i].route[0]).toEqual(rails[i].route[0])
    expect(result[i].route.at(-1)).toEqual(rails[i].route.at(-1))
    const [start, end] = result[i].coupledSection!
    expect(result[i].route[start]).toMatchObject({ x: i * 0.22, y: 1 })
    expect(result[i].route[end]).toMatchObject({ x: i * 0.22, y: 9 })
  }
  expect(rails[0].route).toHaveLength(4)
})

test("nearby rails with the wrong separation do not qualify as a shared bank", () => {
  expect(
    sharedStraightSection(
      [
        rail(
          "p",
          [
            [0, 0],
            [0, 10],
          ],
          [0, 1],
        ),
        rail(
          "n",
          [
            [0.4, 0],
            [0.4, 10],
          ],
          [0, 1],
        ),
      ],
      0.22,
    ),
  ).toBeNull()
})

test("opposite travel and curve chords cannot be reconstructed as parallel offsets", () => {
  const p = rail(
    "p",
    [
      [0, 0],
      [0, 10],
    ],
    [0, 1],
  )
  expect(
    sharedStraightSection(
      [
        p,
        rail(
          "n",
          [
            [0.22, 10],
            [0.22, 0],
          ],
          [0, 1],
        ),
      ],
      0.22,
    ),
  ).toBeNull()
  expect(
    sharedStraightSection(
      [
        { ...p, curvedSegments: [1] },
        rail(
          "n",
          [
            [0.22, 0],
            [0.22, 10],
          ],
          [0, 1],
        ),
      ],
      0.22,
    ),
  ).toBeNull()
})

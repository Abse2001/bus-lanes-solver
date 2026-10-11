import { expect, test } from "bun:test"
import { loadAm3352SbcSample } from "../scripts/am3352-sbc-sample"

for (const scope of ["byte0", "byte1"] as const) {
  test(`${scope} relocation retains complete board obstacles and immutable copper`, () => {
    const published = loadAm3352SbcSample("benchmark")
    const input = loadAm3352SbcSample("benchmark", "byte-corridors", scope)
    expect(input.obstacles).toHaveLength(1111)
    expect(input.traces).toEqual(published.traces)
    const moved = new Set(
      input.obstacles
        .filter(
          (o, index) =>
            JSON.stringify(o.center) !==
            JSON.stringify(published.obstacles[index].center),
        )
        .map((o) => o.componentId),
    )
    expect(moved.size).toBe(7)
    expect(moved.has("pcb_component_0")).toBe(false)
    expect(moved.has("pcb_component_1")).toBe(false)
    expect(input.connections).toHaveLength(11)
  })
}

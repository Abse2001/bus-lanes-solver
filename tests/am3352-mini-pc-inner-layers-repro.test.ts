import { expect, test } from "bun:test"
import {
  hasCompleteInnerRoutes,
  loadMiniPcInput,
  runMiniPcCase,
} from "../scripts/repro-am3352-mini-pc-inner-layers"

test("mini-PC capture preserves 50 DDR signals, original timing and inner carrier layers", async () => {
  const input = await loadMiniPcInput()
  expect(input.layerCount).toBe(4)
  expect(input.allowedLayers).toEqual(["inner1", "inner2"])
  expect(input.connections).toHaveLength(50)
  expect(input.obstacles).toHaveLength(1441)
  expect(input.traces).toEqual([])
  expect(input.buses!.map((bus) => bus.connectionNames.length)).toEqual([
    11, 11, 27, 1,
  ])
  expect(new Set(input.buses!.flatMap((bus) => bus.connectionNames)).size).toBe(
    50,
  )
  for (const bus of input.buses!) {
    expect(bus.allowedLayers).toEqual(["inner1", "inner2"])
    if (bus.busId !== "LAYER_DDR_RESETn") expect(bus.maxLengthSkew).toBe(0.635)
  }
  expect(
    input.differentialPairs!.map((pair) => pair.lengthTolerance).sort(),
  ).toEqual([0.1, 0.127, 0.127])
  expect(hasCompleteInnerRoutes(input, [])).toBe(false)
})

test("an unfinished mini-PC reproduction cannot report connected or matched routes", async () => {
  const report = await runMiniPcCase(0.000001)
  expect(report.passed).toBe(false)
  expect(report.complete).toBe(false)
  expect(report.matched).toBe(false)
  expect(report.inputUnchanged).toBe(true)
  expect(report.routedSignals).toBe(0)
})

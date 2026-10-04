import { expect, test } from "bun:test"
import { BusLanesPipelineSolver } from "../lib"
import {
  coreMultilayerInput,
  validateCoreMultilayer,
} from "../scripts/core-multilayer-sample"

test("the real core address/clock matching bus routes across layers with native copper DRC", () => {
  const input = coreMultilayerInput()
  const before = structuredClone(input)
  const solver = new BusLanesPipelineSolver(input)
  solver.solve()
  const report = validateCoreMultilayer(solver)
  expect(report.complete).toBe(true)
  expect(report.nativeCopperDrc).toBe(true)
  expect(
    Object.values(report.layerCounts).reduce((sum, count) => sum + count, 0),
  ).toBe(47)
  expect(input).toEqual(before)
}, 300_000)

import { expect, test } from "bun:test"
import { FanoutSolver } from "@tscircuit/fanout-solver"
import {
  am3352Hash,
  getAm3352FanoutGeneratorIdentity,
  loadAm3352FanoutRecord,
  prepareAm3352PowerFanout,
} from "../scripts/am3352-samples"

test("fixed AM3352 and RAM power copper exactly replays the recorded FanoutSolver", async () => {
  const installedGenerator = await getAm3352FanoutGeneratorIdentity()
  for (const component of ["soc", "ram"] as const) {
    const record = await loadAm3352FanoutRecord(component)
    const { input, options } = await prepareAm3352PowerFanout(component)
    expect(record.generator).toEqual(installedGenerator)
    expect(am3352Hash(input)).toBe(record.inputSha256)
    expect(options).toEqual(record.options)
    const before = am3352Hash(input)
    const solver = new FanoutSolver(
      input as ConstructorParameters<typeof FanoutSolver>[0],
      record.options,
    )
    solver.solve()
    expect(solver.solved).toBe(true)
    expect(solver.error).toBeNull()
    expect(am3352Hash(input)).toBe(before)
    const output = solver.getOutput()
    expect(output.validation.valid).toBe(true)
    expect(output.fanoutTraces).toEqual(record.output.fanoutTraces)
    expect(output.planeTerminations).toEqual(record.output.planeTerminations)
    expect(output.validation).toEqual(record.output.validation)
    expect(output.fanoutTraces).toHaveLength(component === "soc" ? 122 : 39)
  }
})

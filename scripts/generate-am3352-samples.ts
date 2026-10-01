import { FanoutSolver, validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  am3352Hash,
  getAm3352FanoutGeneratorIdentity,
  prepareAm3352PowerFanout,
  type Am3352FanoutRecord,
} from "./am3352-samples"

const generator = await getAm3352FanoutGeneratorIdentity()
// Keep each complete bus, trace, and plane termination on one line. This makes
// the generated records reviewable without duplicating the native pad capture.
function formatRecord(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth)
  if (Array.isArray(value))
    return value.length
      ? `[\n${value.map((entry) => `${indent}  ${JSON.stringify(entry)}`).join(",\n")}\n${indent}]`
      : "[]"
  if (value && typeof value === "object")
    return `{\n${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(
        ([key, entry]) =>
          `${indent}  ${JSON.stringify(key)}: ${formatRecord(entry, depth + 1)}`,
      )
      .join(",\n")}\n${indent}}`
  return JSON.stringify(value)
}
for (const component of ["soc", "ram"] as const) {
  const { input, options } = await prepareAm3352PowerFanout(component)
  const inputSha256 = am3352Hash(input)
  const solver = new FanoutSolver(
    input as ConstructorParameters<typeof FanoutSolver>[0],
    options,
  )
  solver.solve()
  if (!solver.solved) throw Error(`${component}: ${solver.error}`)
  if (am3352Hash(input) !== inputSha256)
    throw Error("FanoutSolver mutated its input")
  const fullOutput = solver.getOutput()
  const output = {
    fanoutTraces: fullOutput.fanoutTraces,
    planeTerminations: fullOutput.planeTerminations,
    validation: fullOutput.validation,
  }
  const expected = component === "soc" ? 122 : 39
  if (
    !output.validation.valid ||
    output.fanoutTraces.length !== expected ||
    output.planeTerminations.length !== expected
  )
    throw Error(`${component}: incomplete or invalid power fanout`)
  const drc = validateRoutedCopperDrc({
    inputSrj: input as ConstructorParameters<typeof FanoutSolver>[0],
    routedSrj: { ...fullOutput.simpleRouteJson, traces: output.fanoutTraces },
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  })
  if (!drc.valid)
    throw Error(
      `${component}: power copper DRC ${JSON.stringify(drc.issues.slice(0, 5))}`,
    )
  const record: Am3352FanoutRecord = {
    generator,
    component,
    coordinateFrame: "component_local_mm",
    inputSha256,
    options,
    optionsSha256: am3352Hash(options),
    output,
    tracesSha256: am3352Hash(output.fanoutTraces),
    outputSha256: am3352Hash(output),
  }
  await Bun.write(
    new URL(
      `../tests/fixtures/am3352-ram/${component}-power-fanout.json`,
      import.meta.url,
    ),
    formatRecord(record) + "\n",
  )
  console.log(
    `${component}: ${expected} real power dogbones, ${drc.checkedViaCount} vias, DRC clean (${generator.name}@${generator.version})`,
  )
}

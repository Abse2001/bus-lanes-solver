import { expect, test } from "bun:test"
import { runCaBusCase, withAm3352CaBus } from "../scripts/repro-am3352-ca-bus"
import { loadAm3352Sample } from "../scripts/am3352-samples"

test("CA reproduction changes only bus constraints on the native powered fixture", async () => {
  const { input, metadata } = await loadAm3352Sample("inner-layers")
  const original = structuredClone(input)
  const result = withAm3352CaBus(input, metadata.signalNames)
  expect(input).toEqual(original)
  expect({ ...result, buses: undefined }).toEqual({
    ...original,
    buses: undefined,
  })
  expect(result.buses!.slice(0, 2)).toEqual(original.buses!)
  const ca = result.buses![2]
  const names = ca.connectionNames.map((name) => metadata.signalNames[name])
  expect(new Set(names).size).toBe(24)
  expect(names).toContain("DDR_CK")
  expect(names).toContain("DDR_CKn")
  expect(names).not.toContain("DDR_RESETn")
  expect(
    names.every((name) =>
      /^DDR_(A\d+|BA[012]|CSn0|CASn|RASn|WEn|CKE|ODT|CK|CKn)$/.test(name),
    ),
  ).toBe(true)
  expect(ca.maxLengthSkew).toBe(0.635)
  expect(result.allowedLayers).toEqual(["inner1", "inner2"])
  expect(result.traces).toHaveLength(161)
  expect(result.differentialPairs).toEqual(original.differentialPairs)
  expect(new Set(result.buses!.flatMap((b) => b.connectionNames)).size).toBe(46)
})

test("CA reproduction refuses a missing signal or duplicate bus", async () => {
  const { input, metadata } = await loadAm3352Sample("inner-layers")
  const missing = structuredClone(input)
  missing.connections = missing.connections.filter(
    (c) => metadata.signalNames[c.name] !== "DDR_CKE",
  )
  expect(() => withAm3352CaBus(missing, metadata.signalNames)).toThrow("24")
  expect(() =>
    withAm3352CaBus(
      withAm3352CaBus(input, metadata.signalNames),
      metadata.signalNames,
    ),
  ).toThrow("already exists")
})

test("an unfinished CA reproduction cannot invoke its routed-artifact exporter", async () => {
  let exported = false
  const report = await runCaBusCase(true, 0.000001, async () => {
    exported = true
  })
  expect(report.passed).toBe(false)
  expect(exported).toBe(false)
})

test("declared complete-CA benchmark preserves all three exact timing buses", async () => {
  const { validateAm3352Sample } = await import(
    "../scripts/validate-am3352-sample"
  )
  const baseline = await loadAm3352Sample("inner-layers")
  const sample = await loadAm3352Sample("inner-layers-complete-ca")
  expect(sample.input).toEqual(
    withAm3352CaBus(baseline.input, baseline.metadata.signalNames),
  )
  expect(
    (await validateAm3352Sample(sample.input, sample.metadata)).valid,
  ).toBe(true)
  for (const change of ["missing", "skew", "membership"] as const) {
    const input = structuredClone(sample.input)
    if (change === "missing") input.buses!.pop()
    if (change === "skew") input.buses![2].maxLengthSkew = 10
    if (change === "membership") input.buses![2].connectionNames.pop()
    await expect(validateAm3352Sample(input, sample.metadata)).rejects.toThrow()
  }
})

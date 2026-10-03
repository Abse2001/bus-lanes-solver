import { expect, test } from "bun:test"
import { withAm3352CaBus } from "../scripts/repro-am3352-ca-bus"
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

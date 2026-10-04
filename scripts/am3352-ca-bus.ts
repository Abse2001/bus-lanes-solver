import type { SimpleRouteJson } from "../lib"

/** Add only the missing clocked address/control timing group. Native pads,
 * signal identities, byte/pair rules, and fixed power fanouts stay identical.
 * This requests geometric skew matching, not full TI DDR electrical signoff.
 */
export function withAm3352CaBus(
  input: SimpleRouteJson,
  signalNames: Record<string, string>,
): SimpleRouteJson {
  const result = structuredClone(input)
  const signals = new Set([
    ...Array.from({ length: 13 }, (_, i) => `DDR_A${i}`),
    "DDR_BA0",
    "DDR_BA1",
    "DDR_BA2",
    "DDR_CSn0",
    "DDR_CASn",
    "DDR_RASn",
    "DDR_WEn",
    "DDR_CKE",
    "DDR_ODT",
    "DDR_CK",
    "DDR_CKn",
  ])
  const connections = result.connections.filter((c) =>
    signals.has(signalNames[c.name]),
  )
  if (
    connections.length !== 24 ||
    new Set(connections.map((c) => signalNames[c.name])).size !== 24
  )
    throw Error("Expected all 24 AM3352 address/control/clock signals")
  if (result.buses?.some((b) => b.busId === "DDR_ADDR_CTRL_CK"))
    throw Error("Address/control/clock bus already exists")
  result.buses = [
    ...(result.buses ?? []),
    {
      busId: "DDR_ADDR_CTRL_CK",
      name: "DDR_ADDR_CTRL_CK",
      connectionNames: connections.map((c) => c.name),
      maxLengthSkew: 0.635,
      allowedLayers: ["inner1", "inner2"],
    },
  ]
  return result
}

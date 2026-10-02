import { expect, test } from "bun:test"
import type { SimpleRouteJson, Trace } from "../lib"
import { loadAm3352Sample } from "../scripts/am3352-samples"
import { validateAm3352OutputShape } from "../scripts/validate-am3352-sample"

async function fixture() {
  const { input, metadata } = await loadAm3352Sample("control")
  // This fixture checks the public output contract only. These direct wires
  // deliberately are not a routing, native DRC, or length-matching pass.
  const signals: Trace[] = input.connections.map((connection) => ({
    type: "pcb_trace",
    pcb_trace_id: connection.name,
    connection_name: connection.name,
    route: connection.pointsToConnect.map((point) => ({
      ...point,
      route_type: "wire",
      width: 0.1,
    })),
  }))
  const output: SimpleRouteJson = {
    ...structuredClone(input),
    traces: structuredClone([...metadata.fixedFanoutTraces, ...signals]),
  }
  return { input, metadata, signals, output }
}

test("public AM3352 output retains exactly 161 fixed plus 47 identical signal traces", async () => {
  const { input, metadata, signals, output } = await fixture()
  expect(() =>
    validateAm3352OutputShape(input, metadata, signals, output),
  ).not.toThrow()
  const malformed = [
    { ...output, traces: output.traces!.slice(0, -1) },
    { ...output, traces: [...output.traces!, signals[0]] },
    {
      ...output,
      traces: [
        output.traces![1],
        output.traces![0],
        ...output.traces!.slice(2),
      ],
    },
    structuredClone(output),
  ]
  malformed.at(-1)!.traces![161].route[0].x += 0.001
  for (const wrong of malformed)
    expect(() =>
      validateAm3352OutputShape(input, metadata, signals, wrong),
    ).toThrow("output changed fixed power copper or native routing input")
  expect(() =>
    validateAm3352OutputShape(input, metadata, signals.slice(0, -1), output),
  ).toThrow("output changed fixed power copper or native routing input")
})

test("correct output counts cannot conceal changed native terminals, rules, or power copper", async () => {
  const { input, metadata, signals, output } = await fixture()
  const wrongTerminal = structuredClone(output)
  wrongTerminal.connections[0].pointsToConnect[0].pcb_port_id = "other_port"
  const wrongRules = structuredClone(output)
  wrongRules.bounds.maxX += 1
  const wrongPower = structuredClone(output)
  wrongPower.traces![0].route[0].x += 0.001
  for (const wrong of [wrongTerminal, wrongRules, wrongPower])
    expect(() =>
      validateAm3352OutputShape(input, metadata, signals, wrong),
    ).toThrow("output changed fixed power copper or native routing input")
})

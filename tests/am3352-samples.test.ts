import { expect, test } from "bun:test"
import type { SimpleRouteJson, Trace } from "../lib"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import {
  am3352SamplePlacements,
  loadAm3352NativeInput,
  loadAm3352Sample,
} from "../scripts/am3352-samples"
import { validateAm3352Sample } from "../scripts/validate-am3352-sample"

test("the four AM3352 samples translate only RAM and retain every real power dogbone", async () => {
  expect(am3352SamplePlacements.map((p) => p.name)).toEqual([
    "control",
    "right",
    "left",
    "above",
  ])
  const control = await loadAm3352Sample("control")
  const ramComponentId = control.metadata.powerPadManifest.find(
    (p) => p.component === "ram",
  )!.componentId
  const ramPorts = new Set(
    control.input.obstacles
      .filter((o) => o.componentId === ramComponentId)
      .map(
        (o) =>
          (o as typeof o & { circuitJsonMetadata: { pcb_port_id: string } })
            .circuitJsonMetadata.pcb_port_id,
      ),
  )
  for (const placement of am3352SamplePlacements) {
    const { input, metadata } = await loadAm3352Sample(placement.name)
    const before = JSON.stringify({ input, metadata })
    const dx = placement.ram.x - control.metadata.placement.ram.x
    const dy = placement.ram.y - control.metadata.placement.ram.y
    expect(input.connections).toHaveLength(47)
    expect(input.obstacles).toHaveLength(420)
    expect(input.traces).toHaveLength(161)
    expect(input.buses!.map((bus) => bus.allowedLayers)).toEqual([
      ["inner1", "inner2", "bottom"],
      ["inner1", "inner2", "bottom"],
    ])
    expect(input.traces).toEqual(metadata.fixedFanoutTraces)
    expect(metadata.powerConnections).toHaveLength(161)
    expect(
      metadata.powerPadManifest.filter((p) => p.component === "soc"),
    ).toHaveLength(122)
    expect(
      metadata.powerPadManifest.filter((p) => p.component === "ram"),
    ).toHaveLength(39)
    for (let i = 0; i < input.obstacles.length; i++) {
      const pad = input.obstacles[i],
        original = control.input.obstacles[i]
      const moved = pad.componentId === ramComponentId
      expect(pad.center).toEqual({
        x: original.center.x + (moved ? dx : 0),
        y: original.center.y + (moved ? dy : 0),
      })
      expect(pad.width).toBe(original.width)
      expect(pad.height).toBe(original.height)
      expect(pad.componentId).toBe(original.componentId)
      expect(pad.layers).toEqual(original.layers)
      expect(pad.connectedTo).toEqual(original.connectedTo)
    }
    for (let i = 0; i < input.connections.length; i++) {
      const connection = input.connections[i]
      expect(connection.name).toBe(control.input.connections[i].name)
      for (let j = 0; j < connection.pointsToConnect.length; j++) {
        const point = connection.pointsToConnect[j]
        const original = control.input.connections[i].pointsToConnect[j]
        const moved = ramPorts.has(point.pcb_port_id ?? point.pointId ?? "")
        expect(point).toEqual({
          ...original,
          x: original.x + (moved ? dx : 0),
          y: original.y + (moved ? dy : 0),
        })
      }
    }
    const audit = await validateAm3352Sample(input, metadata)
    expect(audit.valid).toBe(true)
    expect(audit.complete).toBe(false)
    expect(audit.combinedDrc).toBeNull()
    expect(audit.fixedPowerTraces).toBe(161)
    expect(audit.fixedPowerVias).toBe(161)
    expect(audit.fixedPowerPadJoins).toBe(161)
    expect(audit.fixedDrc.issues).toEqual([])
    expect(JSON.stringify({ input, metadata })).toBe(before)
  }
})

test("moving RAM translates only its physical terminals, including the clock's shared-net CPU pad", async () => {
  const native = await loadAm3352NativeInput()
  const { metadata } = await loadAm3352Sample("control")
  const ramComponentId = metadata.powerPadManifest.find(
    (p) => p.component === "ram",
  )!.componentId
  const ramPorts = new Set(
    native.obstacles
      .filter((o) => o.componentId === ramComponentId)
      .map(
        (o) =>
          (o as typeof o & { circuitJsonMetadata: { pcb_port_id: string } })
            .circuitJsonMetadata.pcb_port_id,
      ),
  )
  const cpuPorts = new Set(
    native.obstacles
      .filter((o) => o.componentId !== ramComponentId)
      .map(
        (o) =>
          (o as typeof o & { circuitJsonMetadata: { pcb_port_id: string } })
            .circuitJsonMetadata.pcb_port_id,
      ),
  )
  for (const placement of am3352SamplePlacements) {
    const { input, metadata } = await loadAm3352Sample(placement.name)
    let cpuTerminals = 0,
      ramTerminals = 0
    for (const [i, connection] of input.connections.entries()) {
      for (const [j, point] of connection.pointsToConnect.entries()) {
        const original = native.connections[i].pointsToConnect[j]
        const port = original.pcb_port_id ?? original.pointId ?? ""
        if (cpuPorts.has(port)) {
          expect(point).toEqual(original)
          cpuTerminals++
        } else {
          expect(ramPorts.has(port)).toBe(true)
          expect(point).toEqual({
            ...original,
            x: original.x + placement.ram.x,
            y: original.y + (placement.ram.y + 27),
          })
          ramTerminals++
        }
      }
    }
    expect(cpuTerminals).toBe(47)
    expect(ramTerminals).toBe(47)
    expect(
      input.connections.find((c) => c.name === "source_trace_15")!
        .pointsToConnect[0],
    ).toEqual(
      native.connections.find((c) => c.name === "source_trace_15")!
        .pointsToConnect[0],
    )
    expect((await validateAm3352Sample(input, metadata)).valid).toBe(true)
  }
})

test("native supply domains, capacitor outputs, monitor pins and explicit ground ties remain distinct", async () => {
  const { metadata } = await loadAm3352Sample("control")
  expect(
    metadata.powerPadManifest.filter((p) => p.role === "ground"),
  ).toHaveLength(67)
  expect(
    metadata.powerPadManifest.filter((p) => p.role === "supply"),
  ).toHaveLength(90)
  expect(
    metadata.powerPadManifest.filter((p) => p.role === "monitor"),
  ).toHaveLength(1)
  expect(
    metadata.powerPadManifest.filter((p) => p.role === "decoupling_output"),
  ).toHaveLength(3)
  for (const signal of ["VREFN", "RTC_KALDO_ENn", "VPP"])
    expect(
      metadata.powerPadManifest.find((p) => p.signal === signal)?.net,
    ).toBe("GND")
  for (const pad of metadata.powerPadManifest) {
    const power = metadata.powerConnections.find(
      (c) => c.name === pad.connectionName,
    )!
    expect(power.pointsToConnect).toHaveLength(1)
    expect(power.netConnectionName).toBe(pad.net)
    expect(power.pointsToConnect[0].pcb_port_id).toBe(pad.pcbPortId)
    if (pad.role === "monitor" || pad.role === "decoupling_output")
      expect(pad.net).toBe(pad.signal)
    if (
      pad.component === "soc" &&
      pad.role === "supply" &&
      pad.signal !== "VDDS_DDR"
    )
      expect(pad.net).toBe(pad.signal)
  }
})

test("fixture audit rejects changed fixed copper even when input and metadata share the changed object", async () => {
  const { input, metadata } = await loadAm3352Sample("control")
  input.traces![0].route[0].x += 0.01
  await expect(validateAm3352Sample(input, metadata)).rejects.toThrow(
    "fixed power dogbone differs from the native solver record",
  )
})

test("fixture audit rejects merged power domains and missing original pad ownership", async () => {
  const altered = await loadAm3352Sample("control")
  const monitor = altered.metadata.powerPadManifest.find(
    (p) => p.role === "monitor",
  )!
  altered.metadata.powerConnections.find(
    (c) => c.name === monitor.connectionName,
  )!.netConnectionName = "DDR_1V5"
  await expect(
    validateAm3352Sample(altered.input, altered.metadata),
  ).rejects.toThrow("power domains or original pad identities changed")
  const detached = await loadAm3352Sample("control")
  const pad = detached.metadata.powerPadManifest[0]
  const obstacle = detached.input.obstacles.find((o) =>
    o.connectedTo.includes(pad.pcbSmtpadId),
  )!
  obstacle.connectedTo = obstacle.connectedTo.filter(
    (token) => token !== pad.connectionName,
  )
  await expect(
    validateAm3352Sample(detached.input, detached.metadata),
  ).rejects.toThrow("native component pad geometry or ownership changed")
})

test("fixture audit rejects relaxed signal constraints and extra signal-to-power aliases", async () => {
  const relaxed = await loadAm3352Sample("control")
  relaxed.input.buses![0].maxLengthSkew = 100
  await expect(
    validateAm3352Sample(relaxed.input, relaxed.metadata),
  ).rejects.toThrow("native board rules or signal constraints changed")
  const topAllowed = await loadAm3352Sample("control")
  topAllowed.input.buses![0].allowedLayers!.push("top")
  await expect(
    validateAm3352Sample(topAllowed.input, topAllowed.metadata),
  ).rejects.toThrow("native board rules or signal constraints changed")
  const aliased = await loadAm3352Sample("control")
  const pad = aliased.metadata.powerPadManifest[0]
  aliased.input.obstacles
    .find((o) => o.connectedTo.includes(pad.pcbSmtpadId))!
    .connectedTo.push(aliased.input.connections[0].name)
  await expect(
    validateAm3352Sample(aliased.input, aliased.metadata),
  ).rejects.toThrow("native component pad geometry or ownership changed")
})

test("a failed or empty routing is recorded as incomplete rather than a matching pass", async () => {
  const { input, metadata } = await loadAm3352Sample("control")
  const report = await validateAm3352Sample(input, metadata, [])
  expect(report.valid).toBe(false)
  expect(report.complete).toBe(false)
  expect(report.matched).toBe(false)
  expect(report.fixedDrc.valid).toBe(true)
  expect(report.combinedDrc?.valid).toBe(true)
  expect(report.busLengths).toHaveLength(2)
  expect(report.pairLengths).toHaveLength(3)
  expect(report.busLengths.every((b) => b.skewMm === null && !b.matched)).toBe(
    true,
  )
  expect(report.pairLengths.every((p) => p.skewMm === null && !p.matched)).toBe(
    true,
  )
})

test("completed-copper audit refuses thinner wires/vias and geometry outside native board layers", async () => {
  const { input, metadata } = await loadAm3352Sample("control")
  const signal = structuredClone(metadata.fixedFanoutTraces[0])
  signal.pcb_trace_id = "invalid_signal_dimensions"
  signal.connection_name = input.connections[0].name
  for (const point of signal.route)
    if (point.route_type === "wire") point.width = 0.01
    else point.via_diameter = 0.25
  const dimensionReport = await validateAm3352Sample(input, metadata, [signal])
  expect(dimensionReport.valid).toBe(false)
  expect(dimensionReport.issues).toContain(
    `${signal.connection_name}: invalid copper dimensions`,
  )
  signal.route[0].x = input.bounds.maxX + 1
  const boardReport = await validateAm3352Sample(input, metadata, [signal])
  expect(boardReport.issues).toContain(
    `${signal.connection_name}: copper is outside native board/layers`,
  )
  signal.route[0].x = 0
  for (const point of signal.route)
    if (point.route_type === "wire") point.layer = "nonphysical"
  const layerReport = await validateAm3352Sample(input, metadata, [signal])
  expect(layerReport.issues).toContain(
    `${signal.connection_name}: copper is outside native board/layers`,
  )
})

/** A copper subset in the native board's empty corner isolates the carrier
 * policy from pad connectivity and bus matching. The original native pads,
 * constraints and fixed power remain present in every physical DRC audit. */
function isolatedCarrier(
  input: SimpleRouteJson,
  name: string,
  carrierLayer: string,
): Trace {
  const x = input.bounds.maxX - 5,
    y = input.bounds.maxY - 5
  const stubLayer = carrierLayer === "top" ? "bottom" : "top"
  const connection = input.connections.find((c) => c.name === name)!
  const width =
    input.buses?.find((b) => b.connectionNames.includes(name))?.traceWidth ??
    connection.nominalTraceWidth ??
    connection.width ??
    input.minTraceWidth
  const wire = (x: number, layer: string) => ({
    route_type: "wire" as const,
    x,
    y,
    layer,
    width,
  })
  const via = (x: number, from_layer: string, to_layer: string) => ({
    route_type: "via" as const,
    x,
    y,
    from_layer,
    to_layer,
    layers: ["top", "inner1", "inner2", "bottom"],
    via_diameter: input.minViaPadDiameter!,
    via_hole_diameter: input.minViaHoleDiameter!,
  })
  return {
    type: "pcb_trace",
    pcb_trace_id: `carrier-policy:${name}`,
    connection_name: name,
    route: [
      wire(x - 1, stubLayer),
      wire(x, stubLayer),
      via(x, stubLayer, carrierLayer),
      wire(x, carrierLayer),
      wire(x + 2, carrierLayer),
      via(x + 2, carrierLayer, stubLayer),
      wire(x + 2, stubLayer),
      wire(x + 3, stubLayer),
    ],
  }
}

test("AM3352 rejects physically clear TOP carriers for bus and non-bus signals while allowing TOP dogbone stubs", async () => {
  const { input, metadata } = await loadAm3352Sample("control")
  const before = JSON.stringify({ input, metadata })
  const busSignal = input.buses![0].connectionNames[0]
  const controlSignal = input.connections.find(
    (connection) =>
      !input.buses!.some((bus) =>
        bus.connectionNames.includes(connection.name),
      ) &&
      !input.differentialPairs!.some((pair) =>
        pair.connectionNames.includes(connection.name),
      ),
  )!.name
  for (const name of [busSignal, controlSignal]) {
    for (const layer of ["top", "inner1", "inner2", "bottom"]) {
      const signal = isolatedCarrier(input, name, layer)
      const report = await validateAm3352Sample(input, metadata, [signal])
      const carrier = signal.route.slice(3, 5)
      expect(
        carrier.every((p) => p.route_type === "wire" && p.layer === layer),
      ).toBe(true)
      expect(
        tuningPathIsSelfClear(
          carrier,
          input.minTraceWidth + input.minTraceToPadEdgeClearance!,
        ),
      ).toBe(true)
      expect(report.complete).toBe(false)
      expect(report.combinedDrc?.valid).toBe(true)
      expect(report.combinedDrc?.issues).toEqual([])
      const policyIssue = `${name}: carrier must use inner1, inner2, or bottom`
      expect(report.issues.includes(policyIssue)).toBe(layer === "top")
      expect(report.issues).not.toContain(`${name}: invalid copper dimensions`)
      expect(report.issues).not.toContain(
        `${name}: copper is outside native board/layers`,
      )
      if (layer !== "top" || name === controlSignal)
        expect(report.issues).not.toContain(
          `${name}: carrier must be a clear single-layer route`,
        )
      if (layer !== "top") {
        expect(signal.route[0].route_type).toBe("wire")
        expect((signal.route[0] as { layer: string }).layer).toBe("top")
      }
    }
  }
  expect(JSON.stringify({ input, metadata })).toBe(before)
})

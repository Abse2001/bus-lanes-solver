import { expect, test } from "bun:test"
import {
  am3352SamplePlacements,
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

test("every signal terminal stays on its own physical pad in all placements", async () => {
  for (const placement of am3352SamplePlacements) {
    const { input } = await loadAm3352Sample(placement.name)
    for (const connection of input.connections) {
      const components = []
      for (const point of connection.pointsToConnect) {
        const pad = input.obstacles.find(
          (o) =>
            (o as typeof o & { circuitJsonMetadata: { pcb_port_id: string } })
              .circuitJsonMetadata.pcb_port_id === point.pcb_port_id,
        )!
        expect(pad).toBeDefined()
        expect(point.x).toBeCloseTo(pad.center.x, 8)
        expect(point.y).toBeCloseTo(pad.center.y, 8)
        expect(point.x).toBeGreaterThan(input.bounds.minX)
        expect(point.x).toBeLessThan(input.bounds.maxX)
        expect(point.y).toBeGreaterThan(input.bounds.minY)
        expect(point.y).toBeLessThan(input.bounds.maxY)
        components.push(pad.componentId)
      }
      expect(new Set(components).size).toBe(2)
    }
  }
})

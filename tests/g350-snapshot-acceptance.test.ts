import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadG350Am3352Sample,
  g350Am3352Metadata,
} from "../scripts/g350-am3352-sample"
import { exportG350RoutedSnapshot } from "../scripts/snapshot-g350-am3352"
import { validateG350Am3352Sample } from "../scripts/validate-g350-am3352-sample"

test("incomplete G350 copper cannot create routed snapshot artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g350-snapshot-"))
  try {
    await expect(
      exportG350RoutedSnapshot(loadG350Am3352Sample(), directory, "original"),
    ).rejects.toThrow("Refusing a G350 routed snapshot")
    expect(await readdir(directory)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("49 connected paths through foreign pads cannot create routed snapshots", async () => {
  const input = loadG350Am3352Sample()
  const output = {
    ...input,
    traces: input.connections.map((connection) => ({
      type: "pcb_trace" as const,
      pcb_trace_id: `invalid_${connection.name}`,
      connection_name: connection.name,
      source_trace_id: connection.name,
      route: connection.pointsToConnect.map((point) => ({
        route_type: "wire" as const,
        x: point.x,
        y: point.y,
        layer: point.layer,
        width: 0.1016,
      })),
    })),
  }
  const validation = validateG350Am3352Sample(input, output)
  expect(validation.connectedSignals).toBe(49)
  expect(validation.drc.valid).toBe(false)
  const directory = await mkdtemp(join(tmpdir(), "g350-snapshot-"))
  try {
    await expect(
      exportG350RoutedSnapshot(output, directory, "original"),
    ).rejects.toThrow("Refusing a G350 routed snapshot")
    expect(await readdir(directory)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("committed input snapshot matches the fixture and never claims routing acceptance", async () => {
  const root = new URL("../docs/g350-am3352/", import.meta.url)
  const manifest = JSON.parse(
    await readFile(new URL("g350-input.json", root), "utf8"),
  )
  expect(manifest.kind).toBe("input")
  expect(manifest.routingAccepted).toBe(false)
  expect(manifest.inputFixtureSha256).toBe(
    g350Am3352Metadata.filesSha256["native-input.json"],
  )
  for (const [name, expected] of Object.entries(manifest.filesSha256))
    expect(
      createHash("sha256")
        .update(await readFile(new URL(name, root)))
        .digest("hex"),
    ).toBe(expected as string)
  const svg = await readFile(new URL("g350-input.svg", root), "utf8")
  expect(svg).toContain("INPUT / NOT ROUTED")
  expect(svg).toContain("NOT PCB copper")
})

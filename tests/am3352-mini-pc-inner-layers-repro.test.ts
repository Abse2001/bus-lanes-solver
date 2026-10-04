import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "../lib"
import {
  inspectMiniPcRoutes,
  validateMiniPcInput,
} from "../scripts/repro-am3352-mini-pc-inner-layers"
import provenance from "./fixtures/am3352-mini-pc-inner-layers/provenance.json"

test("mini-PC capture preserves all 50 native signals, exact source provenance, and both inner carrier layers", async () => {
  const directory = `${import.meta.dir}/fixtures/am3352-mini-pc-inner-layers`
  const compressed = Buffer.from(
    await Bun.file(`${directory}/input.json.gz`).arrayBuffer(),
  )
  const inputText = gunzipSync(compressed).toString("utf8")
  const optionsText = await Bun.file(`${directory}/options.json`).text()
  const defaultOptionsText = await Bun.file(
    `${directory}/default-options.json`,
  ).text()
  expect(createHash("sha256").update(inputText).digest("hex")).toBe(
    provenance.inputSha256,
  )
  expect(createHash("sha256").update(optionsText).digest("hex")).toBe(
    provenance.optionsSha256,
  )
  expect(createHash("sha256").update(defaultOptionsText).digest("hex")).toBe(
    provenance.defaultOptionsSha256,
  )
  expect(JSON.parse(defaultOptionsText)).toEqual({})
  const input = JSON.parse(inputText) as SimpleRouteJson
  const unchanged = structuredClone(input)
  validateMiniPcInput(input)
  expect(input).toEqual(unchanged)
  expect(input.obstacles).toHaveLength(provenance.inputObstacleCount)
  expect(input.connections.map((connection) => connection.name).sort()).toEqual(
    Object.keys(provenance.signalNames).sort(),
  )
  expect(provenance.source.ram_package_rotation_override).toBe(90)
  expect(provenance.source.source_copper_records).toBe(0)
  const missingSignal = structuredClone(input)
  missingSignal.connections.pop()
  expect(() => validateMiniPcInput(missingSignal)).toThrow("50-signal")
  const weakenedBus = structuredClone(input)
  weakenedBus.buses![0].maxLengthSkew = 1
  expect(() => validateMiniPcInput(weakenedBus)).toThrow("timing bound")
  const outerCarrier = structuredClone(input)
  outerCarrier.allowedLayers = ["inner1", "bottom"]
  expect(() => validateMiniPcInput(outerCarrier)).toThrow("inner carriers")
  const incomplete = inspectMiniPcRoutes(input, [])
  expect(incomplete.complete).toBe(false)
  expect(incomplete.endpointIssues).toHaveLength(51)
})

import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadG350Am3352Sample } from "../scripts/g350-am3352-sample"
import { exportG350Snapshot } from "../scripts/snapshot-g350-am3352"

test("incomplete G350 routing cannot write a review snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g350-snapshot-"))
  try {
    await expect(
      exportG350Snapshot(loadG350Am3352Sample(), directory),
    ).rejects.toThrow("Refusing a G350 snapshot")
    expect(await readdir(directory)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

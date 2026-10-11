import { expect, test } from "bun:test"
import { validateFanoutProvenance } from "../scripts/validate-fanout-provenance"
test("all eight saved fanouts retain their recorded provenance and copper geometry", async () => {
  for (const profile of [
    "ddr_left_io_right",
    "ddr_right_io_left",
    "ddr_top_io_bottom",
    "ddr_bottom_io_top",
  ]) {
    const meta = await Bun.file(
      `tests/fixtures/two-fanouts/${profile}.meta.json`,
    ).json()
    expect((await validateFanoutProvenance(meta)).verifiedPaths).toBe(66)
    const altered = structuredClone(meta)
    altered.fixedFanoutTraces[0].route[1].x += 0.01
    await expect(validateFanoutProvenance(altered)).rejects.toThrow(
      "differs from real solver output",
    )
  }
})

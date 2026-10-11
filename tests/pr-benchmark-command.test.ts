import { expect, test } from "bun:test"
import { parseBenchmarkCommand } from "../scripts/pr-benchmark/command.js"

test("benchmark comments select only a bounded duration for the complete dataset", () => {
  expect(parseBenchmarkCommand("/benchmark")).toEqual({ timeoutSeconds: 3600 })
  expect(
    parseBenchmarkCommand(" /benchmark\r\n--timeout-seconds 120 "),
  ).toEqual({
    timeoutSeconds: 120,
  })
  expect(parseBenchmarkCommand("/benchmark --timeout-seconds 3600")).toEqual({
    timeoutSeconds: 3600,
  })
  for (const body of ["ordinary comment", "/benchmark-other", "`/benchmark`"])
    expect(parseBenchmarkCommand(body)).toBeNull()
  for (const args of [
    "--worker control",
    "--output arbitrary.json",
    "--routes-directory snapshots",
    "--timeout-seconds 0",
    "--timeout-seconds 3601",
    "--timeout-seconds 1.5",
    "--timeout-seconds NaN",
    "--timeout-seconds 120; echo injected",
    "--timeout-seconds 120 --worker control",
  ])
    expect(() => parseBenchmarkCommand(`/benchmark ${args}`)).toThrow()
})

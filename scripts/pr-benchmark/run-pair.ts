import { spawn } from "node:child_process"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { SamplePairArtifact, WorkerArtifact } from "./report"
import { SAMPLE_NAMES } from "./report"

const MAX_LOG_CHARACTERS = 2_000_000

/** Fresh process per solver. Always retain a result, even after a crash/kill. */
export async function runBenchmarkProcess(
  args: string[],
  cwd: string,
  deadlineMilliseconds: number,
): Promise<WorkerArtifact & { stdout: string; stderr: string }> {
  const start = performance.now()
  const childEnv = { ...process.env }
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ])
    delete childEnv[name]
  const child = spawn(process.execPath, args, {
    cwd,
    env: childEnv,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = "",
    timedOut = false,
    error: string | null = null
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + String(chunk)).slice(-MAX_LOG_CHARACTERS)
  })
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-MAX_LOG_CHARACTERS)
  })
  const deadline = setTimeout(() => {
    timedOut = true
    if (!child.pid) return
    try {
      if (process.platform === "win32") child.kill("SIGKILL")
      else process.kill(-child.pid, "SIGKILL")
    } catch {
      // A process that just exited will still deliver its close event.
    }
  }, deadlineMilliseconds)
  const exitCode = await new Promise<number | null>((finish) => {
    child.on("error", (cause) => {
      error = cause.message
    })
    child.on("close", (code) => finish(code))
  })
  clearTimeout(deadline)
  let report: unknown = null
  const lines = stdout.split("\n").filter((line) => line.startsWith("REPORT "))
  if (lines.length === 1) {
    try {
      report = JSON.parse(lines[0].slice(7))
    } catch {
      error = "Worker returned malformed JSON"
    }
  } else error ??= `Worker returned ${lines.length} reports; expected one`
  if (timedOut) error = "Worker exceeded its process deadline"
  else if (exitCode !== 0) error ??= `Worker exited ${exitCode}`
  return {
    report,
    wallMilliseconds: performance.now() - start,
    exitCode,
    error,
    timedOut,
    stdout,
    stderr,
  }
}

interface PairOptions {
  sample: string
  timeoutSeconds: number
  mainSolverPath: string
  prSolverPath: string
  outputPath: string
  mainSha: string
  prSha: string
  controllerSha: string
  /** Test-only substitution; the CLI always uses the trusted benchmark script. */
  workerPath?: string
}

export async function runPair(options: PairOptions) {
  const index = SAMPLE_NAMES.indexOf(
    options.sample as (typeof SAMPLE_NAMES)[number],
  )
  if (index < 0) throw Error("Unknown benchmark placement")
  if (
    !Number.isSafeInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > 3600
  )
    throw Error("Invalid benchmark duration")
  for (const sha of [options.mainSha, options.prSha, options.controllerSha])
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw Error("Expected pinned commit SHAs")
  const order: ["main", "pr"] | ["pr", "main"] =
    index % 2 ? ["pr", "main"] : ["main", "pr"]
  const pendingWorker: WorkerArtifact = {
    report: null,
    wallMilliseconds: 0,
    exitCode: null,
    error: "Worker has not completed",
    missing: true,
  }
  const pair: SamplePairArtifact = {
    sample: options.sample as (typeof SAMPLE_NAMES)[number],
    timeoutSeconds: options.timeoutSeconds,
    main: { ...pendingWorker },
    pr: { ...pendingWorker },
    metadata: {
      order,
      mainSha: options.mainSha,
      prSha: options.prSha,
      controllerSha: options.controllerSha,
      bunVersion: Bun.version,
      platform: process.platform,
      architecture: process.arch,
      runnerName: process.env.RUNNER_NAME ?? "local",
      runnerOS: process.env.RUNNER_OS ?? process.platform,
    },
  }
  const outputPath = resolve(options.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  const retainPair = async () => {
    await writeFile(outputPath + ".tmp", JSON.stringify(pair, null, 2) + "\n")
    await rename(outputPath + ".tmp", outputPath)
  }
  await retainPair()
  const workerPath =
    options.workerPath ?? resolve(import.meta.dir, "../benchmark.ts")
  for (const ref of order) {
    console.log(
      `${options.sample}: running ${ref} (${options[`${ref}Sha`].slice(0, 7)})`,
    )
    const result = await runBenchmarkProcess(
      [
        workerPath,
        "--worker",
        options.sample,
        "--timeout-seconds",
        String(options.timeoutSeconds),
        "--solver",
        resolve(ref === "main" ? options.mainSolverPath : options.prSolverPath),
      ],
      resolve(import.meta.dir, "../.."),
      (options.timeoutSeconds + 120) * 1000,
    )
    const { stdout, stderr, ...artifact } = result
    pair[ref] = artifact
    // A cancelled run still uploads valid JSON with explicit missing endpoints.
    await retainPair()
    await writeFile(outputPath + `.${ref}.stdout.log`, stdout)
    await writeFile(outputPath + `.${ref}.stderr.log`, stderr)
  }
  return pair
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const expected = [
    "--sample",
    "--timeout-seconds",
    "--main",
    "--pr",
    "--output",
    "--main-sha",
    "--pr-sha",
    "--controller-sha",
  ]
  const options = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    if (!expected.includes(args[i]) || !args[i + 1] || options.has(args[i]))
      throw Error("Invalid paired benchmark arguments")
    options.set(args[i], args[i + 1])
  }
  if (expected.some((name) => !options.has(name)))
    throw Error("Missing benchmark arguments")
  await runPair({
    sample: options.get("--sample")!,
    timeoutSeconds: Number(options.get("--timeout-seconds")),
    mainSolverPath: options.get("--main")!,
    prSolverPath: options.get("--pr")!,
    outputPath: options.get("--output")!,
    mainSha: options.get("--main-sha")!,
    prSha: options.get("--pr-sha")!,
    controllerSha: options.get("--controller-sha")!,
  })
}

import { execFileSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { lengthTuningConsumerSource } from "./package-length-tuning-consumer"

const root = resolve(import.meta.dir, "..")
const temporary = mkdtempSync(join(tmpdir(), "solver-package-"))
const run = (command: string, args: string[], cwd = root) =>
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, npm_config_cache: join(temporary, "npm-cache") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })

try {
  // Pack the same artifact that npm publish sends to GitHub Packages.
  const [packed] = JSON.parse(
    run("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporary,
    ]),
  )
  const allowedRoot = /^(package\.json|readme(?:\..*)?|licen[cs]e(?:\..*)?)$/i
  for (const { path } of packed.files) {
    if (!path.startsWith("dist/") && !allowedRoot.test(path)) {
      throw new Error(`Unexpected published file: ${path}`)
    }
  }
  if (packed.unpackedSize > 5 * 1024 * 1024) {
    throw new Error(
      `Package exceeded the 5 MiB unpacked budget: ${packed.unpackedSize}`,
    )
  }
  const consumer = join(temporary, "consumer")
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  )
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(temporary, packed.filename),
    ],
    consumer,
  )
  const name = "@tscircuit/bus-lanes-solver"
  const installed = JSON.parse(
    readFileSync(join(consumer, "node_modules", name, "package.json"), "utf8"),
  )
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (Object.keys(installed[field] ?? {}).length)
      throw new Error(`Unexpected consumer ${field}`)
  }
  const source = lengthTuningConsumerSource
  writeFileSync(
    join(consumer, "consumer.js"),
    new Bun.Transpiler({ loader: "ts" }).transformSync(source),
  )
  writeFileSync(join(consumer, "consumer.ts"), source)
  run("node", ["consumer.js"], consumer)
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: false,
      },
      files: ["consumer.ts"],
    }),
  )
  run(
    "node",
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      join(consumer, "tsconfig.json"),
    ],
    consumer,
  )
  const browser = await Bun.build({
    entrypoints: [join(consumer, "consumer.js")],
    target: "browser",
    format: "iife",
    outdir: join(temporary, "browser"),
  })
  if (!browser.success)
    throw new AggregateError(browser.logs, "Browser consumer build failed")
  // Execute without Node globals too: bundling alone misses eager runtime leaks.
  runInNewContext(
    await browser.outputs[0].text(),
    {
      structuredClone,
      performance,
      console,
      setTimeout,
      clearTimeout,
      TextEncoder,
      TextDecoder,
    },
    { timeout: 30000 },
  )
  console.log(
    `${packed.name}: ${packed.files.length} files, ${packed.unpackedSize} bytes unpacked; isolated Node, browser runtime, and strict TypeScript length-tuning consumers passed`,
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

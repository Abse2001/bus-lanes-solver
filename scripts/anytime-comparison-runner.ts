import { createHash } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

export type ComparisonSourceFingerprint = {
  sha256: string
  files: Record<string, string>
}

const sourceTrees = [
  { path: "lib", extensions: [".ts", ".tsx"] },
  { path: "scripts", extensions: [".ts", ".tsx"] },
  { path: "tests/fixtures/am3352-ram", extensions: [".json"] },
  { path: "tests/fixtures/two-fanouts", extensions: [".json"] },
]
const sourceFiles = ["examples/vector-channel.ts", "package.json"]
const slashPath = (path: string) => path.split(sep).join("/")
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex")

/** Hash source bytes and their sorted relative names. New modules/fixtures,
 * deletions and renames change the inventory as well as the combined digest.
 * Symlinked source trees/files are rejected rather than left mutable. Shared
 * node_modules is deliberately outside this source fingerprint's scope. */
export async function fingerprintComparisonSources(
  root: string,
): Promise<ComparisonSourceFingerprint> {
  const directory = resolve(root)
  const rootInfo = await lstat(directory)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw Error("Comparison source root must be an ordinary directory")
  const paths: string[] = []
  async function assertSourcePath(path: string, isDirectory: boolean) {
    const components = path.split("/")
    for (let index = 0; index < components.length; index++) {
      const partial = components.slice(0, index + 1).join("/")
      const info = await lstat(join(directory, partial))
      if (info.isSymbolicLink())
        throw Error(`Comparison source symlink is unsupported: ${partial}`)
      const directoryExpected = index < components.length - 1 || isDirectory
      if (directoryExpected ? !info.isDirectory() : !info.isFile())
        throw Error(
          `Comparison source must be a regular ${directoryExpected ? "directory" : "file"}: ${partial}`,
        )
    }
  }
  async function walk(path: string, extensions: string[]) {
    const absolute = join(directory, path)
    if ((await lstat(absolute)).isSymbolicLink())
      throw Error(`Comparison source symlink is unsupported: ${path}`)
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink())
        throw Error(
          `Comparison source symlink is unsupported: ${slashPath(child)}`,
        )
      if (entry.isDirectory()) await walk(child, extensions)
      else if (
        entry.isFile() &&
        extensions.some((extension) => entry.name.endsWith(extension))
      )
        paths.push(slashPath(child))
    }
  }
  for (const tree of sourceTrees) {
    await assertSourcePath(tree.path, true)
    await walk(tree.path, tree.extensions)
  }
  for (const path of sourceFiles) {
    await assertSourcePath(path, false)
    paths.push(path)
  }
  paths.sort()
  const files: Record<string, string> = {}
  for (const path of paths)
    files[path] = digest(await readFile(join(directory, path)))
  const combined = createHash("sha256")
  for (const path of paths)
    combined.update(path).update("\0").update(files[path]).update("\n")
  return { sha256: combined.digest("hex"), files }
}

function assertFingerprint(
  expected: ComparisonSourceFingerprint,
  actual: ComparisonSourceFingerprint,
  where: string,
) {
  if (expected.sha256 === actual.sha256) return
  const changed = [
    ...new Set([...Object.keys(expected.files), ...Object.keys(actual.files)]),
  ]
    .filter((path) => expected.files[path] !== actual.files[path])
    .sort()
  const summary =
    changed.slice(0, 8).join(", ") +
    (changed.length > 8 ? `, and ${changed.length - 8} more` : "")
  throw Error(
    `Comparison sources changed in ${where}: ${summary || "combined fingerprint mismatch"}. Refusing final artifact publication; discard this run's staged results.`,
  )
}

/** Copies are ordinary read-only files; no mutable source symlinks survive.
 * Only node_modules is shared. The returned guard checks both the live source
 * inventory and frozen copies, including read-only protection. The caller must
 * invoke it before launching jobs and again before publishing staged artifacts. */
export async function createFrozenComparisonWorkspace(
  originalRoot: string,
): Promise<{
  directory: string
  sourceFingerprint: ComparisonSourceFingerprint
  assertUnchanged(): Promise<void>
}> {
  const original = resolve(originalRoot)
  const before = await fingerprintComparisonSources(original)
  const directory = await mkdtemp("/tmp/bus-lanes-anytime-final-")
  const folders = new Set<string>()
  async function createSourceDirectory(folder: string) {
    await mkdir(folder, { recursive: true })
    while (folder !== directory) {
      folders.add(folder)
      folder = dirname(folder)
    }
  }
  try {
    // Empty selected source trees are part of the snapshot's structure too.
    for (const tree of sourceTrees)
      await createSourceDirectory(join(directory, tree.path))
    for (const path of Object.keys(before.files)) {
      const destination = join(directory, path)
      await createSourceDirectory(dirname(destination))
      await writeFile(destination, await readFile(join(original, path)), {
        mode: 0o444,
      })
    }
    const snapshot = await fingerprintComparisonSources(directory)
    const after = await fingerprintComparisonSources(original)
    assertFingerprint(before, snapshot, "the frozen workspace during capture")
    assertFingerprint(before, after, "the original workspace during capture")
    await symlink(
      join(original, "node_modules"),
      join(directory, "node_modules"),
      "dir",
    )
    for (const folder of [...folders].sort((a, b) => b.length - a.length))
      await chmod(folder, 0o555)
    const sourceFingerprint = Object.freeze({
      sha256: before.sha256,
      files: Object.freeze({ ...before.files }),
    })
    async function assertUnchanged() {
      try {
        const [currentOriginal, currentFrozen] = await Promise.all([
          fingerprintComparisonSources(original),
          fingerprintComparisonSources(directory),
        ])
        assertFingerprint(
          sourceFingerprint,
          currentOriginal,
          "the original workspace",
        )
        assertFingerprint(
          sourceFingerprint,
          currentFrozen,
          "the frozen workspace",
        )
        for (const path of Object.keys(sourceFingerprint.files))
          if ((await lstat(join(directory, path))).mode & 0o222)
            throw Error(`Frozen source became writable: ${path}`)
        for (const folder of folders)
          if ((await lstat(folder)).mode & 0o222)
            throw Error(
              `Frozen source directory became writable: ${slashPath(relative(directory, folder))}`,
            )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("Refusing final artifact publication")) throw error
        throw Error(
          `Comparison source guard failed: ${message}. Refusing final artifact publication; discard this run's staged results.`,
        )
      }
    }
    await assertUnchanged()
    return { directory, sourceFingerprint, assertUnchanged }
  } catch (error) {
    // Remove only this helper's newly created directory. Restore directory
    // permissions first; recursively deleting read-only parents would fail.
    for (const folder of [...folders].sort((a, b) => a.length - b.length))
      await chmod(folder, 0o755).catch(() => {})
    await rm(directory, { recursive: true, force: true })
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Refusing final artifact publication")) throw error
    throw Error(
      `Could not freeze comparison sources: ${message}. Refusing final artifact publication; no final comparison run was launched.`,
    )
  }
}

/** Start jobs in input order, with at most concurrency callbacks active.
 * First failure stops dequeueing and rejects promptly so the caller can kill
 * active subprocesses. Promise.all observes every worker's eventual rejection;
 * callbacks already running are not cancelled or awaited after that rejection.
 * The caller owns their process termination/exit waits before cleanup/publish. */
export async function runComparisonJobs<T>(
  jobs: T[],
  concurrency: number,
  run: (job: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw Error("Comparison concurrency must be a positive integer")
  const queued = jobs.slice()
  let next = 0
  let stopped = false
  async function worker() {
    while (!stopped && next < queued.length) {
      const index = next++
      try {
        await run(queued[index], index)
      } catch (error) {
        stopped = true
        throw error
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queued.length) }, () =>
      worker(),
    ),
  )
}

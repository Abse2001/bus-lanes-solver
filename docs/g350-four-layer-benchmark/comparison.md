Frozen checkpoint: **5/11 accepted, six timeouts, exit 1** with `--require-all-solved`.
Each accepted case connected all 47 signals and passed combined copper DRC and full-copper length matching. These are the eleven legacy placements, not the exact 49-signal G350 board.

The measured source was copied into an immutable snapshot before later fixes. Its **217-file** source/harness/fixture SHA-256 is `116838825126711b3b228b06cf3f71d8e2f7c9327cd7b7c65f080bc5ed1105c2` (captured 2026-10-17 16:48:56 UTC). All 217 hashes matched before and after execution. [report.json](report.json) contains the manifest, reconstruction patch and per-case input hashes.

Workers ran serially in fresh Bun 1.4.3 processes, with a 180 s solve budget and a 195 s parent process deadline. The committed comparison used 3600 s per case and accepted 11/11. Machine load and dependency/runtime conditions are not controlled between historical runs.

| Case | Historical s (3600 s cap) | Checkpoint s (180 s cap) | Connectivity / DRC / matching |
| --- | ---: | ---: | --- |
| control | 69.153 | 114.173 | 47/47; pass / pass |
| control-inner1 | 1906.120 | 180.175 timeout | 47 provisional traces; unaudited |
| right | 54.406 | 71.444 | 47/47; pass / pass |
| left | 69.314 | 104.173 | 47/47; pass / pass |
| above | 80.479 | 114.591 | 47/47; pass / pass |
| inner-layers | 105.011 | 118.302 | 47/47; pass / pass |
| inner-layers-right | 141.706 | 180.796 timeout | 47 provisional traces; unaudited |
| inner-layers-left | 210.172 | 180.000 timeout | 0 provisional traces; unaudited |
| inner-layers-above | 261.317 | 180.001 timeout | 0 provisional traces; unaudited |
| inner-layers-complete-ca | 314.996 | 180.000 timeout | 0 provisional traces; unaudited |
| outer-layers | 1270.066 | 195.147 wall; killed | Worker report unavailable; unaudited |

**Budget regression risk:** `inner-layers-right` timed out at 180.796 s, versus historical 141.706 s and an earlier live diagnostic at 177.776 s. The other five timed-out cases also exceeded 180 s historically. The differing budgets and timing conditions cannot establish that those five have lost routing capability or isolate the cause of the slower right case.

Both cases reporting 47 provisional traces lack a completed routed DRC and matching audit. The killed `outer-layers` worker returned no report: its raw fallback zero solve time, zero counts and false preservation flags mean unavailable evidence. Its measured wall time was 195.147 s. Input and fixed-fanout immutability passed **10/10 available audits**; the outer audit is unavailable. Each accepted output preserved all 161 fixed fanouts and contained 208 traces, including the 47 new signals.

Accepted full-copper skews below include supplied fixed fanouts and new interconnect. BYTE0/BYTE1 tolerance is 0.635 mm; each pair tolerance is 0.127 mm. Values are rounded to six decimals; the JSON retains measured precision and validator verdicts. The complete-CA case timed out, so no CA matching pass is claimed.

| Case | BYTE0 mm | BYTE1 mm | pair_0 mm | pair_1 mm | pair_2 mm |
| --- | ---: | ---: | ---: | ---: | ---: |
| control | 0.635000 | 0.635000 | 0.077868 | 0.127000 | 0.072830 |
| right | 0.635000 | 0.635000 | 0.127000 | 0.121802 | 0.102644 |
| left | 0.635000 | 0.629947 | 0.068825 | 0.127000 | 0.105429 |
| above | 0.635000 | 0.635000 | 0.127000 | 0.127000 | 0.127000 |
| inner-layers | 0.635000 | 0.589950 | 0.077868 | 0.127000 | 0.127000 |

**Later source checks:** local revision `93f10c15f8488e3706c6b5984a4324981b79be18` (identical Git tree to [published commit 4aace54](https://github.com/Abse2001/bus-lanes-solver/commit/4aace54b1fa1b6a62838075d77b24e6d55e54b84)) passed `bun test` (**583 pass, 0 fail**, 185 files), `bun run typecheck`, and `bun run test:package` (isolated Node, browser and TypeScript consumers). These are checks of that later commit, not results for the frozen checkpoint. After the checkpoint, this commit skips singleton shortcut searches, spreads generated pair approaches at both package ends including outermost columns, repeats spreading after refinement, and preserves qualified seed geometry during revalidation. The four changed library files are listed in the JSON. Any subsequent working-tree edits are outside both reported revisions.

To reconstruct the exact measured source from the later commit, run from this repository in a separate worktree. The JSON patch restores only the four differing library files; the script verifies every measured file and the combined digest before benchmarking:

```sh
git worktree add --detach /tmp/g350-benchmark-checkpoint 4aace54b1fa1b6a62838075d77b24e6d55e54b84
python3 - docs/g350-four-layer-benchmark/report.json /tmp/g350-benchmark-checkpoint <<'PY'
import hashlib, json, subprocess, sys
from pathlib import Path
checkpoint = json.loads(Path(sys.argv[1]).read_text())["checkpoint"]
root = Path(sys.argv[2])
patch = "\n".join(checkpoint["currentToCheckpointPatchLines"]) + "\n"
subprocess.run(["git", "apply", "-"], cwd=root, input=patch, text=True, check=True)
digest = hashlib.sha256()
for name, expected in sorted(checkpoint["fileSha256"].items()):
    content = (root / name).read_bytes()
    assert hashlib.sha256(content).hexdigest() == expected, name
    digest.update(name.encode() + b"\0" + content + b"\0")
assert digest.hexdigest() == checkpoint["sourceHarnessAndFixturesSha256"]
PY
cd /tmp/g350-benchmark-checkpoint
bun install
./benchmark.sh --timeout-seconds 180 --require-all-solved \
  --output /tmp/g350-checkpoint-report.json \
  --routes-directory /tmp/g350-checkpoint-routes
```

The source reconstruction was exercised successfully. Dependency installation and host load can change timings; the original run reused its installed dependency tree. This directory commits only report data, with no route artifacts or images.

A subsequent checked source tree, local `18491580f3875b9b5cba16c7a8a49c8741293606` (identical to [published commit d2976c0](https://github.com/Abse2001/bus-lanes-solver/commit/d2976c007e79165758e0df3d711cf2365f372ee0)), passed all **600 tests** across 191 files, type checking, and the isolated Node/browser/TypeScript package checks. It adds fair sparse conflict repairs and tuning within generated multivia approaches. These checks do not extend the benchmark results to that source revision or establish complete G350 routing.

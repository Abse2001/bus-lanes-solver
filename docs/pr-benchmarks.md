# Pull-request benchmarks

Comment `/benchmark` on an open pull request to compare the latest `main`
commit with that PR's current head. The requester must have write, maintain, or
admin access to the repository. The workflow posts a queued comment, then
updates it with completion counts, P50/P80/P90/P95 times, completion changes,
and every placement's result. Exact commit SHAs and raw artifacts are linked.

The default solver budget is 3600 seconds per placement and revision. For a
shorter diagnostic run, use `/benchmark --timeout-seconds 120`. Only this
integer option, from 1 through 3600, is accepted. Short budgets can leave
otherwise routable placements unfinished. The workflow can also be dispatched
manually from Actions on the default branch with a PR number and budget.

## What is compared

All eleven AM3352 placements are included. The baseline is the latest `main`,
including for stacked PRs whose GitHub base is another feature branch. Both
commit SHAs and the trusted harness SHA are pinned before any solver runs.

Each placement runs main and PR sequentially on the same GitHub-hosted machine,
in fresh processes with Bun 1.3.14. The order alternates between placements.
Dependencies are installed before either revision is timed; committed lockfiles
are respected, when present. This repository currently does not commit a
lockfile, so dependency ranges resolve at installation time. Three placement
jobs can run concurrently. Each job has a 150-minute limit, and each worker
also has a process deadline beyond its solver budget. A full comparison can
take several hours.

The default-branch harness supplies the fixture, input hash, and independent
acceptance checks for both solvers. Acceptance requires all 47 signals, native
combined-copper DRC, full-copper bus and pair matching, coupling, and unchanged
161 fixed power dogbones with their provenance. The additional complete-CA
timing group does not add signals. The per-placement table includes DRC status,
bus and pair copper skews, runtime, and input hashes.

## Reading the timing tables

The first table reports completion and **budgeted time to valid completion**
across all eleven placements. Accepted cases use their routing time. Failed,
timed-out, crashed, invalid, or missing cases receive the full solver budget.
This keeps a PR that loses slow successes from appearing faster by dropping
those cases.

The second table reports actual routing times on the **same placements accepted
by both revisions**, with percentile changes. It is suppressed when input or
revision evidence is inconsistent or results are incomplete. Lost and gained
accepted placements are listed separately. A failure of the first revision
does not prevent the second from running. Missing results remain visible and
are never presented as evidence of no regression.

Percentiles use linear interpolation at sorted index `(n - 1) * p`. These are
eleven distinct routing problems, with one run per revision and placement;
percentile changes are descriptive and can vary with the runner. Only solver
execution is timed; installation, fixture loading, and independent validation
are excluded. Worker wall time is retained in the JSON.

## CI and activation

Normal CI runs smoke tests, visual snapshot checks, and focused regressions
with a 120-second default per-test limit. The expensive full-board tests and
automatic long benchmark job are replaced by this explicit benchmark command.
Small AM62L full-DDR smoke cases and immutable-fanout, geometry, DRC, matching,
and tamper checks remain in the ordinary suite.

GitHub only runs `issue_comment` workflows from the default branch. Merge the
benchmark infrastructure PR into `main` before commenting `/benchmark` on a
solver PR such as #54. The infrastructure belongs on main so a solver change
can be measured before it is merged.

PR solver execution has read-only repository permissions and receives no
write token. A separate job on a fresh runner renders typed JSON artifacts
using trusted reporting code and updates the result comment. Only repository
writers can request the potentially expensive execution of PR code. Raw JSON
and worker logs are retained for 14 days; no partial-route images are exported.

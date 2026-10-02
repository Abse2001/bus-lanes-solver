# Contribution workflow

- Make future changes on a branch and submit a pull request. Do not push changes directly to main.
- Routing PR artifacts must show only successfully completed routes. Include a routed snapshot for each declared AM3352 benchmark sample and inspect every image before submitting. Never commit or attach iteration-zero, intermediate, failed, or unrouted snapshots as PR artifacts; keep diagnostic captures local. Snapshot exporters must verify solver success and complete connectivity before writing artifacts.
- Run `./benchmark.sh` and report connectivity, DRC, per-bus total copper length skew, and runtime. Do not count a routing-only pass as a length-matching pass.
- Keep fixed FanoutSolver outputs immutable and retain their provenance. Matching measurements include both fixed fanouts and the new interconnect.

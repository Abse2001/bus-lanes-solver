# Vector routing audit

The previous raster search has been removed. The router now builds a visibility graph from the corners of clearance-offset copper. Each graph edge is an analytic horizontal, vertical, or 45-degree polyline. Collision predicates operate on continuous segments, rectangles and via disks; there is no cell size or coordinate stepping. Terminal fields are swept perpendicular to the channel direction, grouped by layer, with alternate winding orders on failure.

Completed DDR snapshots are reproducible with `bun scripts/snapshot-routed-ddr.ts`. PR artifacts contain completed routing only; the iteration captures described below are historical diagnostics, not the PR artifact policy.

## Examined iterations

- Old grid: iterations 100 and 1,000 remained behind an earlier lane. At iteration 10,000, the search had produced a roughly 70 mm detour across an approximately 18 mm gap. See `iterations/grid-baseline`.
- Initial vector replacement: iteration 500 exposed incompatible handoff winding. Changing the search representation alone did not fix the input fanouts. See `iterations/vector-first`.
- Staggered obstacle case: iteration 4 follows an offset obstacle corner; iteration 8 commits the first detour and explores the next lane. Iteration 18 completes all three lanes with continuous, clearance-checked 45-degree bends. See `iterations/vector-final/obstacle-channel-*`.
- Final DDR cases: snapshots at iterations 0, 10, 30 and completion preserve all fixed copper, colored by layer. Left, right and top finish at iteration 36; bottom finishes at iteration 111. The left iteration-10 image shows partial carriers joining the unchanged fanouts; its final image completes the diagonal inner-layer bank alongside the straight lanes. Top and right retain continuous parallel carriers. Bottom uses continuous 45-degree bends between staggered banks. See `iterations/fast-routing`.

All four samples pass: 132/132 DDR connections, independent combined-copper DRC, and zero circuit errors in all four actual core builds. Measured solver times are 103 ms (bottom), 10 ms (left), 7 ms (right), and 8 ms (top). Including output DRC, the benchmark takes 127, 34, 40, and 42 ms respectively. Each sample has a one-second deadline. Clear channels use analytic shortest connectors before constructing any visibility graph; obstructed channels still use continuous clearance-offset geometry.

## Fanout provenance

All eight fanouts are exact, reproducible outputs of FanoutSolver 0.0.78. The right RAM uses official `connectionExitTargets` guidance from the SoC exits; top coordinates the SoC to the RAM. Bottom escapes the SoC through its left side into a bottom bank. Left locks successful layer assignments, preserves differential-pair winding, guides edge-pin escapes, and gives the RAM inner2 group a corner bank. These are solver inputs, not edits to generated route coordinates. All four layouts retain identical SoC ball positions and orientation, and the fanout regions have a 17.76 mm margin. The bus router sweeps the outside of each bend first, following terminal winding. Input, options and complete output remain committed and are checked by exact reproduction tests.

The original fanout inputs explicitly enable `allowViaInPad`. That fabrication assumption is now preserved in sample metadata and supplied to independent DRC; it is not a waiver of trace/via spacing checks. Interconnect routing itself never creates vias.

## Limits

A visibility-graph search failure is not a proof of planar impossibility. The router has bounded winding retries. Length tuning uses collision-checked chamfered detours; impedance uses a caller-provided width/impedance calibration. Neither is an electromagnetic simulation or complete DDR timing closure. Coupled differential geometry is rejected rather than silently ignored.

## Length-matched samples

The routing-only baseline above did not request length matching. Including both fixed fanouts exposed up to 24.7 mm of skew. The current examples request 0.1 mm maximum skew for RAM_BYTE0, RAM_BYTE1 and RAM_CA. All 12 groups now measure less than 0.000001 mm total planar copper skew, while retaining the exact fixed fanouts. Package delay, via depth and layer-dependent propagation velocity are outside this geometric measurement.

The tuner generates continuous chamfered accordion patterns on axial or diagonal carrier segments. It revisits a blocked lane after other lanes have moved, checks other-net and returning-arm clearance, and validates the final total lengths. Candidates are generated lazily; the full solves measured 54–268 ms, or 90–341 ms including independent output DRC. All four actual core builds finish without circuit errors.

Current snapshots are in `iterations/length-matched`, with iteration-zero, intermediate and completed images for each sample. The per-bus lengths and skew are included in the snapshot JSON and debugger statistics.

Visual review: iteration-zero and intermediate images retain the same separated, layer-colored fanouts. Completed left, top and right images add accordion sections and larger outer tuning loops where fixed fanout lengths differ most. Bottom places tuning along the diagonal channel. These loops are visible length compensation; the unchanged routing-only images remain available for comparison.

## Smooth serpentine geometry

The initial length tuner used 0.01 mm corner cuts. That made the meanders look square and forced dense teeth between nearly adjacent carrier lanes. The replacement uses lobe-proportional chamfers, a nonzero crown between the two upper chamfers, constant pitch within each tuning section, and at least 3W center-to-center separation between returning arms. There is no fallback to microscopic corner cuts.

If tuning cannot fit between shortest paths, the router spreads the carrier lanes in a central corridor while preserving winding and every fixed handoff point. New transitions remain horizontal, vertical or 45 degrees. It recomputes bus targets after spreading, so added corridor length cannot invalidate matching. This changes only interconnect routes, not the saved fanouts or chip placement.

The geometry follows conventional chamfered serpentine construction; the [TI high-speed interface layout guide](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf) provides background on high-speed length matching and routing. The 3W returning-arm floor is this solver's geometric policy, not a substitute for stackup-specific delay or coupling analysis.

Reviewed initial, intermediate, completed and individual-layer snapshots are in `iterations/smooth-meanders`. The purple inner4 bottom-facing image specifically shows the replacement for the jagged diagonal teeth. Regression checks cover proportional chamfers, returning-arm separation, a maximum 45-degree carrier turn, exact endpoint continuity, total copper skew and independent DRC.

## Distributed tuning

The tuner now considers longest carrier segments first, centers its first candidate, and chooses lobe count from the required added length. This removes the large terminal loops in the four DDR samples while retaining fallback placements when clearance requires them. It is a placement preference, not a guarantee that every route can be tuned in its center.

Snapshots in `iterations/distributed-meanders` include initial, intermediate, complete and individual-layer views. The completed top-facing sample no longer has the long sideways loops at its lower handoff. Left/right use repeated lobes on the long horizontal runs; bottom uses the long diagonal corridor. Small corrections use fewer broad lobes. Fixed fanouts and pre-tuning iterations are unchanged.

The benchmark passes all four full DDR samples (132 connections) and rejects all four mixed-layer negatives. Full solves measured 98–264 ms. All 12 bus groups retain under 0.000001 mm total planar copper skew, independent combined-copper DRC passes, and no layer transitions are added. A synthetic regression preserves both short terminal approaches and checks distributed interior lobes, exact length and returning-arm spacing.

All 12 initial/intermediate PNGs are byte-identical to the reviewed smooth-meanders baseline. All four completed boards and inner4 detail views were inspected. Actual core builds produce zero circuit errors for all four orientations.

## Honor the requested skew

Length targets now use the existing SRJ bus `maxLengthSkew` and pair `lengthTolerance`. The previous matcher collapsed each group to exact equality, ignoring the available tolerance. We now raise only the lengths below each permitted minimum, propagating overlapping bus/pair bounds until stable. Both kinds of bound are validated on the final copper and reported by the debugger. Widths use existing explicit width properties; the unsupported impedance/profile API and demonstration have been removed.

A regression shows a 10 mm / 8 mm pair with a 0.5 mm tolerance produces 10 mm / 9.5 mm, while a 2 mm tolerance adds no meanders. An overlapping 1 mm bus and 0.5 mm pair retain distinct lengths of 10, 9 and 8.5 mm. This computes least non-shortening target lengths for each candidate geometry; corridor spreading is still a feasibility heuristic, not a global minimum-length proof.

The unchanged DDR inputs request 0.1 mm bus skew, so improvement is modest: carrier copper falls by 3.000 mm in bottom, left and right, and 2.998 mm in top. The fixed fanout length differences still require substantial compensation at that tolerance. All four samples pass combined copper DRC, 132/132 carriers route without layer transitions, and all 12 buses stay within 0.1 mm plus numerical precision. Four mixed-layer negatives are rejected. Solves measured 100–306 ms; all four actual core builds have zero circuit errors.

Reviewed layer detail and complete snapshots are in `iterations/skew-tolerances`. The main shapes remain close to the distributed-meanders version, as expected from the small allowed tolerance. All 12 initial/intermediate images are byte-identical to that reviewed baseline. No fanout copper or sample tolerance was changed to improve the score.

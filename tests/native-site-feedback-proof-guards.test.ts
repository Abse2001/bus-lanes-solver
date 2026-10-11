import { expect, spyOn, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import * as dogbones from "../lib/alternate-signal-dogbones"
import { CopperConflictIndex } from "../lib/copper-conflict-index"
import { generatedEscapeHolesConflict } from "../lib/expanded-signal-sites"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import {
  negotiateSignalSites,
  type SignalSiteDomainFailure,
} from "../lib/negotiate-signal-sites"
import { pruneCandidateDomains } from "../lib/prune-candidate-domains"
import { deriveSelectiveNativeApproachGuide } from "../lib/selective-native-approach-guidance"
import type { SimpleRouteJson, Trace } from "../lib/types"
import { fixedCopper } from "../lib/vector-scene"
import {
  guidancePhysicalLayers,
  guidanceWidth,
  jointCpuConflictFixture,
} from "./selective-guidance-fixtures"

function searchedSharedCpuFixture() {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: guidanceWidth,
    minTraceToPadEdgeClearance: guidanceWidth,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -1, maxY: 5 },
    connections: ["A", "B"].map((name, i) => ({
      name,
      pointsToConnect: [
        { x: i ? 0.4 : -0.4, y: 0, layer: "top" },
        { x: i ? 2 : -2, y: 4, layer: "bottom" },
      ],
    })),
    obstacles: [],
    traces: [],
  }
  native.obstacles = native.connections.flatMap((connection) =>
    connection.pointsToConnect.map((point) => ({
      type: "rect",
      shape: "circle" as const,
      center: { x: point.x, y: point.y },
      width: 0.25,
      height: 0.25,
      layers: [point.layer],
      connectedTo: [connection.name],
    })),
  )
  const state: FlexibleSignalState = {
    native,
    pending: native,
    retained: [],
    traces: [],
    escapes: [],
  }
  const approach = (name: string, viaX: number): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `owned_${name}_${viaX}`,
    connection_name: name,
    source_trace_id: name,
    route: [
      {
        route_type: "wire",
        x: name === "A" ? -0.4 : 0.4,
        y: 0,
        layer: "top",
        width: guidanceWidth,
      },
      {
        route_type: "wire",
        x: viaX,
        y: 0.8,
        layer: "top",
        width: guidanceWidth,
      },
      {
        route_type: "via",
        x: viaX,
        y: 0.8,
        from_layer: "top",
        to_layer: "bottom",
        layers: guidancePhysicalLayers,
        via_diameter: 0.4572,
        via_hole_diameter: 0.254,
      },
      {
        route_type: "wire",
        x: viaX,
        y: 0.8,
        layer: "bottom",
        width: guidanceWidth,
      },
    ],
  })
  return { state, approach }
}

for (const unfinished of [false, true]) {
  test(`nonempty offered-site conflict reports ${unfinished ? "unfinished policy as a heuristic" : "completed finite policy"}`, () => {
    const { state, approach } = searchedSharedCpuFixture()
    const before = structuredClone(state)
    const failures: SignalSiteDomainFailure[] = []
    let knownSolved = 0,
      unfinishedSteps = 0
    const generated = spyOn(
      dogbones,
      "routeAlternateSignalDogbones",
    ).mockImplementation((input, _options, attempt) => {
      const connection = input.connections[0]
      const viaX =
        unfinished && attempt % 2 ? (connection.name === "A" ? -0.8 : 0.8) : 0
      const escape = approach(connection.name, viaX)
      const endpoint = connection.pointsToConnect[1]
      return {
        connections: [
          {
            ...connection,
            pointsToConnect: [{ x: viaX, y: 0.8, layer: "bottom" }, endpoint],
          },
        ],
        traces: [
          escape,
          {
            type: "pcb_trace",
            pcb_trace_id: `ram_${connection.name}`,
            connection_name: connection.name,
            source_trace_id: connection.name,
            route: [{ ...endpoint, route_type: "wire", width: guidanceWidth }],
          },
        ],
      } as ReturnType<typeof dogbones.routeAlternateSignalDogbones>
    })
    const originalStep = GridVisibilitySearch.prototype.step
    const child = spyOn(
      GridVisibilitySearch.prototype,
      "step",
    ).mockImplementation(function (this: GridVisibilitySearch) {
      if (Math.abs(this.start.x) > 1e-8) {
        unfinishedSteps++
        return
      }
      originalStep.call(this)
      if (this.solved) knownSolved++
    })
    const work = negotiateSignalSites(
      state,
      new Set(["A", "B"]),
      false,
      false,
      {
        allowExpandedSites: false,
        onSiteDomainFailure: (failure) => failures.push(failure),
      },
    )
    let next = work.next()
    try {
      for (let steps = 0; !next.done && steps < 10000; steps++)
        next = work.next()
      expect(next.done).toBe(true)
      expect(next.value).toBeNull()
      expect(knownSolved).toBe(2)
      expect(unfinishedSteps).toBe(unfinished ? 6000 : 0)
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({
        kind: "incompatible-offered-native-site-domains",
        searchComplete: !unfinished,
        budgetUnknown: unfinished,
      })
      const failure = failures[0] as Extract<
        SignalSiteDomainFailure,
        { kind: "incompatible-offered-native-site-domains" }
      >
      expect(failure.domains.map((domain) => domain.options.length)).toEqual([
        1, 1,
      ])
      for (const domain of failure.domains) {
        const checked = validateRoutedCopperDrc({
          inputSrj: state.native,
          routedSrj: { ...state.native, traces: domain.options[0].escapes },
          clearance: guidanceWidth,
          allowBlindAndBuriedVias: false,
        } as Parameters<typeof validateRoutedCopperDrc>[0])
        expect(checked).toMatchObject({ valid: true, issues: [] })
      }
      expect(state).toEqual(before)
    } finally {
      if (!next.done) work.return(null)
      generated.mockRestore()
      child.mockRestore()
    }
  })
}

function jointGuideFixture(mirror: boolean) {
  const fixture = jointCpuConflictFixture()
  if (mirror) {
    const opposite = (layer: string) =>
      layer === "top" ? "bottom" : layer === "bottom" ? "top" : layer
    // native and physicalInput share geometry, so transform each object once.
    for (const connection of fixture.physicalInput.connections)
      for (const point of connection.pointsToConnect)
        point.layer = opposite(point.layer)
    for (const obstacle of fixture.physicalInput.obstacles)
      obstacle.layers = obstacle.layers.map(opposite)
    const traces = [
      ...fixture.physicalInput.traces!,
      ...fixture.pair,
      ...fixture.originals,
      ...[...fixture.variants.values()].flatMap((options) =>
        options.flatMap((option) => option.escapes),
      ),
    ]
    for (const trace of traces)
      for (const point of trace.route)
        if (point.route_type === "wire") point.layer = opposite(point.layer)
        else {
          point.from_layer = opposite(point.from_layer)
          point.to_layer = opposite(point.to_layer)
        }
    for (const options of fixture.variants.values())
      for (const option of options)
        option.escapeCopper = fixedCopper({
          ...fixture.native,
          obstacles: [],
          traces: option.escapes,
        })
  }
  const domains = [...fixture.variants].map(([name, options]) => ({
    name,
    options,
  }))
  const index = new CopperConflictIndex()
  let failure: SignalSiteDomainFailure | undefined
  expect(
    pruneCandidateDomains(
      domains.map((domain) => domain.options),
      (a, b) =>
        !generatedEscapeHolesConflict(fixture.native, a.escapes, b.escapes) &&
        !index.firstConflict(
          a.escapeCopper,
          b.escapeCopper,
          guidanceWidth - 1e-8,
        ),
      1000000,
      (proof) => {
        failure = {
          kind: "incompatible-offered-native-site-domains",
          searchComplete: true,
          budgetUnknown: false,
          names: domains.map((domain) => domain.name),
          domains,
          proof: { ...proof, kind: "arc-consistency" },
        }
      },
    ),
  ).toBeNull()
  expect(failure).toBeDefined()
  const state: FlexibleSignalState = {
    native: fixture.native,
    pending: {
      ...fixture.native,
      traces: [...fixture.native.traces!, ...fixture.pair],
    },
    retained: fixture.pair,
    traces: [],
    escapes: [],
  }
  return { ...fixture, state, failure: failure! }
}

for (const carrier of ["top", "bottom"]) {
  test(`a genuine common ${carrier} substitution obeys bus carrier permissions`, () => {
    const { state, failure, originals, physicalInput } = jointGuideFixture(
      carrier === "top",
    )
    const buses = ["A", "B"].map((name) => ({
      busId: name,
      connectionNames: [name],
      allowedLayers: [carrier],
    }))
    state.native.buses = buses
    physicalInput.buses = buses
    const permitted = deriveSelectiveNativeApproachGuide(
      state,
      failure,
      originals,
      [],
      { physicalInput },
    )
    expect(permitted.guide).toMatchObject({
      mode: "full",
      trace: { connection_name: "B" },
    })
    expect(permitted.guide!.trace.route.at(-1)).toMatchObject({
      route_type: "wire",
      layer: carrier,
    })
    expect(
      deriveSelectiveNativeApproachGuide(
        state,
        {
          ...failure,
          searchComplete: false,
          budgetUnknown: true,
        } as SignalSiteDomainFailure,
        originals,
        [],
        { physicalInput },
      ).guide,
    ).toEqual(permitted.guide)
    for (const complete of [false, true])
      expect(
        deriveSelectiveNativeApproachGuide(
          state,
          {
            ...failure,
            searchComplete: complete,
            budgetUnknown: complete,
          } as SignalSiteDomainFailure,
          originals,
          [],
          { physicalInput },
        ).guide,
      ).toBeUndefined()
    expect(
      validateRoutedCopperDrc({
        inputSrj: physicalInput,
        routedSrj: {
          ...physicalInput,
          traces: [...physicalInput.traces!, permitted.guide!.trace],
        },
        clearance: guidanceWidth,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0]),
    ).toMatchObject({ valid: true, issues: [] })
    buses[1].allowedLayers = [carrier === "top" ? "bottom" : "top"]
    expect(
      deriveSelectiveNativeApproachGuide(state, failure, originals, [], {
        physicalInput,
      }).guide,
    ).toBeUndefined()
  })
}

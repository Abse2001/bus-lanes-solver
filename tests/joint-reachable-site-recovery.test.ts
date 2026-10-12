import { expect, spyOn, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import * as dogbones from "../lib/alternate-signal-dogbones"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import {
  negotiateSignalSites,
  type SignalSiteDomainFailure,
} from "../lib/negotiate-signal-sites"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { busLengthReports } from "../lib/route-lengths"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"

import * as siteNegotiator from "../lib/negotiate-signal-sites"
import * as pairPlanner from "../lib/plan-shared-pair-corridors"
import * as expansion from "../lib/expanded-signal-sites"
import * as routeFresh from "../lib/route-fresh-surface-buses"
import type { DeferredCarrierExpansion } from "../lib/negotiate-signal-sites"

const width = 0.1016
const span = ["top", "inner1", "inner2", "bottom"]
function octilinear(a: Point, b: Point): Point[] {
  const dx = b.x - a.x,
    dy = b.y - a.y
  const bend =
    Math.abs(dx) > Math.abs(dy)
      ? { x: b.x - Math.sign(dx) * Math.abs(dy), y: a.y }
      : { x: a.x, y: b.y - Math.sign(dy) * Math.abs(dx) }
  return [a, bend, b].filter(
    (point, i, points) =>
      !i ||
      Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y) > 1e-8,
  )
}
function fixture(healthy = false) {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: width,
    minTraceToPadEdgeClearance: width,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
    minBoardEdgeClearance: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -1, maxY: 6 },
    connections: ["A", "B"].map((name, index) => ({
      name,
      pointsToConnect: [0, 4].map((y) => ({
        x: index ? 0.8 : -0.8,
        y,
        layer: "top",
      })),
    })),
    buses: [
      {
        busId: "data",
        connectionNames: ["A", "B"],
        allowedLayers: ["bottom"],
        maxLengthSkew: 0.635,
      },
    ],
    obstacles: [],
    traces: [],
  }
  for (const connection of native.connections)
    for (const point of connection.pointsToConnect)
      native.obstacles.push({
        type: "rect",
        shape: "circle",
        componentId: point.y === 0 ? "cpu" : "ram",
        center: point,
        width: point.y === 0 ? 0.4 : 0.42,
        height: point.y === 0 ? 0.4 : 0.42,
        layers: ["top"],
        connectedTo: [connection.name],
      })
  native.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "immutable_supplied",
    connection_name: "fixed",
    route: [
      { route_type: "wire", x: 2.4, y: -0.5, layer: "top", width },
      { route_type: "wire", x: 2.4, y: 5.2, layer: "top", width },
    ],
  })
  native.connections.push({
    name: "fixed",
    pointsToConnect: [
      { x: 2.4, y: -0.5, layer: "top" },
      { x: 2.4, y: 5.2, layer: "top" },
    ],
  })
  const escape = (name: string, end: number, x: number, y: number): Trace => {
    const pad = native.connections.find((c) => c.name === name)!
      .pointsToConnect[end]
    return {
      type: "pcb_trace",
      pcb_trace_id: `owned_${name}_${end}`,
      connection_name: name,
      source_trace_id: name,
      route: [
        ...octilinear(pad, { x, y }).map((p) => ({
          ...p,
          route_type: "wire" as const,
          layer: "top",
          width,
        })),
        {
          route_type: "via",
          x,
          y,
          from_layer: "top",
          to_layer: "bottom",
          layers: span,
          via_diameter: 0.4572,
          via_hole_diameter: 0.254,
        },
        { route_type: "wire", x, y, layer: "bottom", width },
      ],
    }
  }
  const state: FlexibleSignalState = {
    native,
    pending: {
      ...native,
      connections: native.connections
        .filter((c) => c.name !== "fixed")
        .map((c) => ({
          ...c,
          pointsToConnect: c.pointsToConnect.map((p) => ({
            ...p,
            layer: "bottom",
          })),
        })),
    },
    retained: [],
    traces: [],
    escapes: [],
  }
  const generated = (name: string) => [
    escape(name, 0, healthy && name === "A" ? -0.4 : 0.4, 0.4),
    escape(name, 1, name === "A" ? -0.4 : 0.4, 4.8),
  ]
  return { state, generated }
}

function timingScope(state: FlexibleSignalState): FlexibleSignalState {
  const native = {
    ...state.native,
    connections: state.native.connections.filter(
      (connection) => connection.name !== "fixed",
    ),
  }
  return {
    ...state,
    native,
    pending: {
      ...state.pending,
      connections: state.pending.connections.filter(
        (connection) => connection.name !== "fixed",
      ),
    },
  }
}
function drive(
  state: FlexibleSignalState,
  names: string[],
  options: NonNullable<Parameters<typeof negotiateSignalSites>[4]> = {},
) {
  const work = negotiateSignalSites(state, new Set(names), false, false, {
    allowExpandedSites: true,
    expandOnlyWhenBlocked: true,
    allowFineNativeApproachRetry: false,
    maxCandidateSearchNodes: 12000,
    ...options,
  })
  let next = work.next(),
    yields = 0
  try {
    while (!next.done && yields++ < 100000) next = work.next()
    expect(next.done).toBe(true)
    return { result: next.done ? next.value : null, yields }
  } finally {
    if (!next.done) work.return(null)
  }
}
function joined(state: FlexibleSignalState) {
  return state.traces.map((trace) =>
    joinSignalEscapes(
      trace,
      state.escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    ),
  )
}
function physicalDrc(native: SimpleRouteJson, traces: Trace[]) {
  return validateRoutedCopperDrc({
    inputSrj: native,
    routedSrj: { ...native, traces: [...native.traces!, ...traces] },
    clearance: width,
    allowBlindAndBuriedVias: false,
  } as Parameters<typeof validateRoutedCopperDrc>[0])
}
function installDogbones(f: ReturnType<typeof fixture>) {
  return spyOn(dogbones, "routeAlternateSignalDogbones").mockImplementation(
    (input) => {
      const connection = input.connections[0],
        escapes = f.generated(connection.name)
      return {
        connections: [
          {
            ...connection,
            pointsToConnect: escapes.map((trace) => trace.route.at(-1)!),
          },
        ],
        traces: escapes,
      } as ReturnType<typeof dogbones.routeAlternateSignalDogbones>
    },
  )
}
interface Attempt {
  targets?: readonly DeferredCarrierExpansion[]
  deferAlternate?: boolean
  fine?: boolean
  failures: SignalSiteDomainFailure[]
  result?: FlexibleSignalState | null
  yields: number
}
function fresh(f: ReturnType<typeof fixture>) {
  const state = timingScope(f.state),
    attempts: Attempt[] = [],
    expanded: DeferredCarrierExpansion[] = []
  const originalNegotiate = siteNegotiator.negotiateSignalSites
  const originalExpansion = expansion.expandedSignalSiteChoices
  const observe = spyOn(
    siteNegotiator,
    "negotiateSignalSites",
  ).mockImplementation(function* (...args) {
    const options = args[4],
      record: Attempt = {
        targets: options?.retryReachableSiteExpansions,
        deferAlternate: options?.deferAlternateCarrierExpansion,
        fine: options?.allowFineNativeApproachRetry,
        failures: [],
        yields: 0,
      }
    attempts.push(record)
    const forwarded = {
      ...options,
      onSiteDomainFailure: (failure: SignalSiteDomainFailure) => {
        record.failures.push(failure)
        options?.onSiteDomainFailure?.call(options, failure)
      },
    }
    const work = originalNegotiate(
      args[0],
      args[1],
      args[2],
      args[3],
      forwarded,
    )
    let next = work.next()
    try {
      while (!next.done) {
        record.yields++
        yield next.value
        next = work.next()
      }
      record.result = next.value
      return next.value
    } finally {
      if (!next.done) work.return(null)
    }
  })
  const expand = spyOn(
    expansion,
    "expandedSignalSiteChoices",
  ).mockImplementation(function* (...args) {
    expanded.push({ connectionName: args[1].name, layer: args[2] })
    return yield* originalExpansion(...args)
  })
  const planner = spyOn(
    pairPlanner,
    "planSharedPairCorridors",
  ).mockImplementation(function* () {
    yield []
  })
  const work = routeFresh.routeFreshSurfaceSeeds(
    state.native,
    state.pending,
    [],
    new Map([
      ["A", ["bottom"]],
      ["B", ["bottom"]],
    ]),
    { smoothTuning: true, denseSearch: true },
  )
  let next = work.next(),
    steps = 0
  try {
    while (!next.done && next.value?.phase !== "timing" && steps++ < 100000)
      next = work.next()
    expect(steps).toBeLessThan(100000)
    return {
      checkpoint:
        !next.done && next.value?.phase === "timing" ? next.value.state : null,
      attempts,
      expanded,
    }
  } finally {
    if (!next.done) work.return(null)
    planner.mockRestore()
    expand.mockRestore()
    observe.mockRestore()
  }
}

test("the real fresh caller widens a completed same-carrier contradiction and finishes both physical timing routes", () => {
  const f = fixture(),
    before = structuredClone(f.state),
    generated = installDogbones(f)
  try {
    for (const name of ["A", "B"]) {
      const single = drive(timingScope(f.state), [name], {
        allowExpandedSites: false,
      })
      expect(single.result).toBeTruthy()
      expect(physicalDrc(f.state.native, joined(single.result!))).toMatchObject(
        { valid: true, issues: [] },
      )
    }
    const routed = fresh(f)
    expect(routed.checkpoint).toBeTruthy()
    expect(routed.attempts).toHaveLength(2)
    expect(routed.attempts[0]).toMatchObject({
      targets: undefined,
      fine: false,
      deferAlternate: true,
      result: null,
    })
    expect(routed.attempts[0].failures).toHaveLength(1)
    const failure = routed.attempts[0].failures[0]
    expect(failure).toMatchObject({
      kind: "incompatible-offered-native-site-domains",
      searchComplete: true,
      budgetUnknown: false,
      deferredReachableSiteExpansions: [
        { connectionName: "A", layer: "bottom" },
        { connectionName: "B", layer: "bottom" },
      ],
    })
    const targets = routeFresh.reachableSiteExpansionRetryTargets(failure)
    expect(routed.attempts[1]).toMatchObject({
      targets,
      fine: false,
      deferAlternate: true,
    })
    expect(routed.expanded).toEqual([...targets])
    const copper = joined(routed.checkpoint!)
    expect(busLengthReports(f.state.native, copper)).toMatchObject([
      { toleranceMm: 0.635, matched: true, withinLengthLimit: true },
    ])
    expect(
      busLengthReports(f.state.native, copper)[0].skewMm,
    ).toBeLessThanOrEqual(0.635 + 1e-7)
    expect(copper.map((trace) => trace.connection_name).sort()).toEqual([
      "A",
      "B",
    ])
    expect(routeAnglesAreConventional(copper)).toBe(true)
    expect(physicalDrc(f.state.native, copper)).toMatchObject({
      valid: true,
      issues: [],
    })
    for (const trace of copper) {
      const connection = f.state.native.connections.find(
        (item) => item.name === trace.connection_name,
      )!
      for (const [point, pad] of [
        [trace.route[0], connection.pointsToConnect[0]],
        [trace.route.at(-1)!, connection.pointsToConnect[1]],
      ])
        expect(Math.hypot(point.x - pad.x, point.y - pad.y)).toBeLessThan(1e-8)
      expect(
        trace.route.every(
          (point) =>
            point.route_type !== "wire" ||
            ["top", "bottom"].includes(point.layer),
        ),
      ).toBe(true)
      const vias = trace.route.filter((point) => point.route_type === "via")
      expect(vias).toHaveLength(2)
      for (const via of vias)
        expect(via).toMatchObject({
          layers: span,
          via_diameter: 0.4572,
          via_hole_diameter: 0.254,
        })
      for (const [index, point] of trace.route.entries()) {
        if (point.route_type !== "via") continue
        const prior = trace.route[index - 1],
          after = trace.route[index + 1]
        expect(prior).toMatchObject({
          route_type: "wire",
          layer: point.from_layer,
        })
        expect(after).toMatchObject({
          route_type: "wire",
          layer: point.to_layer,
        })
        expect(Math.hypot(prior.x - point.x, prior.y - point.y)).toBeLessThan(
          1e-8,
        )
        expect(Math.hypot(after.x - point.x, after.y - point.y)).toBeLessThan(
          1e-8,
        )
      }
    }
    expect(routed.checkpoint!.pending.traces).toContainEqual(
      before.native.traces![0],
    )
    expect(f.state).toEqual(before)
  } finally {
    generated.mockRestore()
  }
}, 15000)

test("healthy fresh routing preserves the exact cheap prefix and output without reachable-site retry", () => {
  const f = fixture(true),
    before = structuredClone(f.state),
    generated = installDogbones(f)
  try {
    const cheap = drive(timingScope(f.state), ["A", "B"], {
      allowExpandedSites: false,
    })
    expect(cheap.result).toBeTruthy()
    const routed = fresh(f)
    expect(routed.checkpoint).toBeTruthy()
    expect(routed.attempts).toHaveLength(1)
    expect(routed.attempts[0].targets).toBeUndefined()
    expect(routed.attempts[0].result).toEqual(cheap.result)
    expect(routed.attempts[0].yields).toBe(cheap.yields)
    expect(routed.expanded).toEqual([])
    expect(
      physicalDrc(f.state.native, joined(routed.checkpoint!)),
    ).toMatchObject({ valid: true, issues: [] })
    expect(f.state).toEqual(before)
  } finally {
    generated.mockRestore()
  }
})

test("explicit expansion denial wins over retry targets and cancellation emits no completed joint certificate", () => {
  const f = fixture(),
    generated = installDogbones(f),
    failures: SignalSiteDomainFailure[] = [],
    expanded: string[] = []
  const original = expansion.expandedSignalSiteChoices
  const observe = spyOn(
    expansion,
    "expandedSignalSiteChoices",
  ).mockImplementation(function* (...args) {
    expanded.push(args[1].name)
    return yield* original(...args)
  })
  try {
    const denied = drive(timingScope(f.state), ["A", "B"], {
      allowExpandedSites: false,
      retryReachableSiteExpansions: [
        { connectionName: "A", layer: "bottom" },
        { connectionName: "B", layer: "bottom" },
      ],
      onSiteDomainFailure: (failure) => failures.push(failure),
    })
    expect(denied.result).toBeNull()
    expect(expanded).toEqual([])
    expect(failures).toHaveLength(1)
    expect(routeFresh.reachableSiteExpansionRetryTargets(failures[0])).toEqual(
      [],
    )
    failures.length = 0
    const work = negotiateSignalSites(
      timingScope(f.state),
      new Set(["A", "B"]),
      false,
      false,
      {
        allowExpandedSites: true,
        expandOnlyWhenBlocked: true,
        onSiteDomainFailure: (failure) => failures.push(failure),
      },
    )
    expect(work.next().done).toBe(false)
    work.return(null)
    expect(failures).toEqual([])
    expect(expanded).toEqual([])
  } finally {
    observe.mockRestore()
    generated.mockRestore()
  }
})

test("reachable-site targets require complete trusted native AC metadata and exclude noncore domains", () => {
  const f = fixture(),
    generated = installDogbones(f),
    failures: SignalSiteDomainFailure[] = []
  try {
    expect(
      drive(timingScope(f.state), ["A", "B"], {
        onSiteDomainFailure: (failure) => failures.push(failure),
      }).result,
    ).toBeNull()
    const failure = failures[0]
    if (failure.kind !== "incompatible-offered-native-site-domains")
      throw new Error("Missing physical certificate")
    expect(routeFresh.reachableSiteExpansionRetryTargets(failure)).toHaveLength(
      2,
    )
    for (const changes of [
      { searchComplete: false },
      { budgetUnknown: true },
      { names: [] },
      { names: ["A"] },
      { deferredReachableSiteExpansions: undefined },
      {
        deferredReachableSiteExpansions: [
          { connectionName: "unknown", layer: "bottom" },
        ],
      },
      {
        deferredReachableSiteExpansions: [
          { connectionName: "A", layer: "top" },
        ],
      },
      {
        deferredReachableSiteExpansions: [
          { connectionName: "", layer: "bottom" },
        ],
      },
      { deferredReachableSiteExpansions: [{ connectionName: "A", layer: "" }] },
      { proof: { ...failure.proof, implicatedRemovals: [] } },
    ])
      expect(
        routeFresh.reachableSiteExpansionRetryTargets({
          ...failure,
          ...changes,
        }),
      ).toEqual([])
    expect(routeFresh.reachableSiteExpansionRetryTargets(undefined)).toEqual([])
    for (const malformed of [null, {}]) {
      const copy = structuredClone(failure)
      copy.domains[0].options[0].escapes = [malformed as unknown as Trace]
      expect(routeFresh.reachableSiteExpansionRetryTargets(copy)).toEqual([])
    }
    // An unimplicated extra bank exercises metadata filtering without
    // extending the physical contradiction fixture.
    const extra = {
      name: "unimplicated",
      options: structuredClone(failure.domains[0].options),
    }
    const extended = {
      ...failure,
      domains: [...failure.domains, extra],
      deferredReachableSiteExpansions: [
        ...failure.deferredReachableSiteExpansions!,
        { connectionName: "unimplicated", layer: "bottom" },
      ],
    }
    expect(routeFresh.reachableSiteExpansionRetryTargets(extended)).toEqual(
      failure.deferredReachableSiteExpansions!,
    )
  } finally {
    generated.mockRestore()
  }
})

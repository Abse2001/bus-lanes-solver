import { expect, spyOn, test } from "bun:test"
import * as coupledPair from "../lib/coupled-pair-routing"
import * as pairPlanner from "../lib/plan-shared-pair-corridors"
import { priorityPairPlans } from "../lib/route-fresh-surface-buses"
import { pairLengthReports } from "../lib/route-lengths"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

function fixture(): SimpleRouteJson {
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -6, maxX: 6, minY: -4, maxY: 4 },
    obstacles: [],
    connections: ["P", "N"].map((name, index) => ({
      name,
      pointsToConnect: [-4, 4].map((x) => ({
        x,
        y: index ? 0.11 : -0.11,
        layer: "bottom",
      })),
    })),
    differentialPairs: [
      { connectionNames: ["P", "N"], lengthTolerance: 0.127, traceGap: 0.12 },
    ],
  }
}

function routes(local: SimpleRouteJson, names?: string[]): Trace[] {
  return local.connections
    .filter((connection) => !names || names.includes(connection.name))
    .map((connection) => ({
      type: "pcb_trace",
      pcb_trace_id: `pair_${connection.name}_${connection.pointsToConnect[0].layer}`,
      connection_name: connection.name,
      route: connection.pointsToConnect.map((point) => ({
        ...point,
        route_type: "wire",
        width: local.minTraceWidth,
      })),
    }))
}

function nextPlan(work: Generator<Trace[] | undefined>, budget: number) {
  for (let i = 0; i < budget; i++) {
    const next = work.next()
    if (next.done) return undefined
    if (next.value) return next.value
  }
}

test("surface priority preserves a slower legal preferred carrier before a fast alternate", () => {
  const input = fixture()
  const before = structuredClone(input)
  const available = new Map(
    input.connections.map((connection) => [connection.name, ["bottom", "top"]]),
  )
  const calls: string[] = []
  const stub = spyOn(coupledPair, "routeCoupledPair").mockImplementation(
    function* (local) {
      const layer = local.connections[0].pointsToConnect[0].layer
      calls.push(layer)
      if (layer === "bottom") for (let i = 0; i < 20; i++) yield
      return routes(local)
    },
  )
  const eager = pairPlanner.planSharedPairCorridors(input, available, true, {
    preferPackageOnlyTuning: true,
  })
  const priority = priorityPairPlans(input, available)
  try {
    const alternate = nextPlan(eager, 4)!
    expect(alternate).toHaveLength(2)
    expect(alternate[0].route[0]).toMatchObject({ layer: "top" })
    calls.length = 0
    const preferred = nextPlan(priority, 24)!
    expect(preferred).toHaveLength(2)
    expect(
      preferred.every((trace) => (trace.route[0] as Wire).layer === "bottom"),
    ).toBe(true)
    expect(calls).toEqual(["bottom"])
    expect(pairLengthReports(input, preferred)[0].matched).toBe(true)
    const copper = [...fixedCopper(input), ...preferred.flatMap(routeCopper)]
    for (const trace of preferred) {
      const connection = input.connections.find(
        (c) => c.name === trace.connection_name,
      )!
      expect(
        new VectorScene(input, connection, 0.1, copper).pathVisible(
          trace.route,
        ),
      ).toBe(true)
    }
    expect(input).toEqual(before)
  } finally {
    eager.return(undefined)
    priority.return(undefined)
    stub.mockRestore()
  }
})

test("preferred domains from reserved and ordinary topologies combine before a fast alternate", () => {
  const input = fixture()
  input.connections.push(
    ...input.connections.map((connection, index) => ({
      ...connection,
      name: index ? "R" : "Q",
      pointsToConnect: connection.pointsToConnect.map((point) => ({
        ...point,
        y: point.y + 2,
      })),
    })),
  )
  input.differentialPairs!.push({
    connectionNames: ["Q", "R"],
    lengthTolerance: 0.127,
    traceGap: 0.12,
  })
  const before = structuredClone(input)
  const available = new Map(
    input.connections.map((connection) => [connection.name, ["bottom", "top"]]),
  )
  const calls: Array<{
    name: string
    layer: string
    variant: unknown
    provisional: unknown
  }> = []
  const stub = spyOn(coupledPair, "routeCoupledPair").mockImplementation(
    function* (local, pair, _fixed, options) {
      const layer = local.connections.find(
        (c) => c.name === pair.connectionNames[0],
      )!.pointsToConnect[0].layer
      const name = pair.connectionNames[0]
      calls.push({
        name,
        layer,
        variant: options?.variant,
        provisional: options?.allowProvisionalPairTuning,
      })
      if (layer === "bottom") {
        if (name === "P") {
          if (options?.variant !== 2 || options.allowProvisionalPairTuning)
            return null
          for (let i = 0; i < 20; i++) yield
        } else if (
          options?.variant !== 0 ||
          !options.allowProvisionalPairTuning
        )
          return null
      }
      return routes(local, pair.connectionNames)
    },
  )
  const eager = pairPlanner.planSharedPairCorridors(input, available, true, {
    preferPackageOnlyTuning: true,
  })
  const priority = priorityPairPlans(input, available)
  try {
    const alternate = nextPlan(eager, 8)!
    expect(alternate).toHaveLength(4)
    expect(
      alternate.some((trace) => (trace.route[0] as Wire).layer === "top"),
    ).toBe(true)
    calls.length = 0
    const preferred = nextPlan(priority, 28)!
    expect(preferred).toHaveLength(4)
    expect(
      preferred.every((trace) => (trace.route[0] as Wire).layer === "bottom"),
    ).toBe(true)
    expect(pairPlanner.isProvisionalPairPlan(preferred)).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.name === "P" && call.variant === 2 && call.provisional === false,
      ),
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.name === "Q" && call.variant === 0 && call.provisional === true,
      ),
    ).toBe(true)
    expect(calls.every((call) => call.layer === "bottom")).toBe(true)
    expect(
      pairLengthReports(input, preferred).every((report) => report.matched),
    ).toBe(true)
    const copper = [...fixedCopper(input), ...preferred.flatMap(routeCopper)]
    for (const trace of preferred) {
      const connection = input.connections.find(
        (c) => c.name === trace.connection_name,
      )!
      expect(
        new VectorScene(input, connection, 0.1, copper).pathVisible(
          trace.route,
        ),
      ).toBe(true)
    }
    expect(input).toEqual(before)
  } finally {
    eager.return(undefined)
    priority.return(undefined)
    stub.mockRestore()
  }
})

test("a blocked preferred warm-up spends only two topologies before reaching the alternate", () => {
  const input = fixture()
  const calls: Array<{ layer: string; variant: unknown }> = []
  let slowSteps = 0
  let slowClosed = 0
  const stub = spyOn(coupledPair, "routeCoupledPair").mockImplementation(
    function* (local, _pair, _fixed, options) {
      const layer = local.connections[0].pointsToConnect[0].layer
      calls.push({ layer, variant: options?.variant })
      if (layer === "bottom") {
        try {
          for (let i = 0; i < 10_000; i++) {
            slowSteps++
            yield
          }
          return null
        } finally {
          slowClosed++
        }
      }
      return routes(local)
    },
  )
  const work = priorityPairPlans(
    input,
    new Map(input.connections.map((c) => [c.name, ["bottom", "top"]])),
  )
  try {
    const plan = nextPlan(work, 24_008)!
    expect(plan).toHaveLength(2)
    expect(plan[0].route[0]).toMatchObject({ layer: "top" })
    expect(calls.map((call) => call.layer)).toEqual([
      "bottom",
      "bottom",
      "bottom",
      "bottom",
      "bottom",
      "top",
    ])
    expect(calls.map((call) => call.variant)).toEqual([0, 0, 2, 2, 0, 0])
    expect(slowSteps).toBeLessThan(24_008)
    expect(slowClosed).toBe(4)
  } finally {
    work.return(undefined)
    stub.mockRestore()
  }
  expect(slowClosed).toBe(5)
})

test("cancelling preferred warm-up closes its active bounded search", () => {
  const input = fixture()
  let closed = false
  let steps = 0
  const calls: string[] = []
  const stub = spyOn(coupledPair, "routeCoupledPair").mockImplementation(
    function* (local) {
      calls.push(local.connections[0].pointsToConnect[0].layer)
      try {
        while (true) {
          steps++
          yield
        }
      } finally {
        closed = true
      }
    },
  )
  const work = priorityPairPlans(
    input,
    new Map(input.connections.map((c) => [c.name, ["bottom", "top"]])),
  )
  try {
    expect(nextPlan(work, 5)).toBeUndefined()
    expect(closed).toBe(false)
    expect(steps).toBeLessThanOrEqual(6)
    expect(calls).toEqual(["bottom"])
  } finally {
    work.return(undefined)
    stub.mockRestore()
  }
  expect(closed).toBe(true)
})

test("pairs without a common permitted preference skip warm-up", () => {
  const input = fixture()
  input.connections[1].pointsToConnect =
    input.connections[1].pointsToConnect.map((point) => ({
      ...point,
      layer: "top",
    }))
  const calls: unknown[] = []
  const stub = spyOn(pairPlanner, "planSharedPairCorridors").mockImplementation(
    function* (_input, _layers, _fresh, options) {
      calls.push(options)
      yield routes(input)
    },
  )
  const work = priorityPairPlans(
    input,
    new Map(input.connections.map((c) => [c.name, ["bottom", "top"]])),
  )
  try {
    expect(nextPlan(work, 1)).toHaveLength(2)
    expect(calls).toEqual([{ preferPackageOnlyTuning: true }])
  } finally {
    work.return(undefined)
    stub.mockRestore()
  }
})

test("warm-up duplicate offers preserve distinct provisional policy", () => {
  const input = fixture()
  const preferred = routes(input)
  const provisional = structuredClone(preferred)
  const alternate = routes({
    ...input,
    connections: input.connections.map((connection) => ({
      ...connection,
      pointsToConnect: connection.pointsToConnect.map((point) => ({
        ...point,
        layer: "top",
      })),
    })),
  })
  const stub = spyOn(pairPlanner, "planSharedPairCorridors").mockImplementation(
    function* (_input, _layers, _fresh, options) {
      yield preferred
      yield provisional
      if (options?.maxTopologyVariants !== 2) yield alternate
    },
  )
  const policy = spyOn(pairPlanner, "isProvisionalPairPlan").mockImplementation(
    (plan) => plan === provisional,
  )
  const work = priorityPairPlans(
    input,
    new Map(input.connections.map((c) => [c.name, ["bottom", "top"]])),
  )
  try {
    expect(work.next().value).toBe(preferred)
    expect(work.next().value).toBe(provisional)
    expect(work.next().value).toBe(alternate)
    expect(work.next().done).toBe(true)
  } finally {
    work.return(undefined)
    policy.mockRestore()
    stub.mockRestore()
  }
})

test("cross-stream deduplication retains changed coupling and curve annotations", () => {
  const input = fixture()
  const preferred = routes(input)
  const annotated = structuredClone(preferred)
  annotated[0].coupledSection = [0, 1]
  annotated[0].curvedSegments = [0]
  const stub = spyOn(pairPlanner, "planSharedPairCorridors").mockImplementation(
    function* (_input, _layers, _fresh, options) {
      yield preferred
      if (options?.maxTopologyVariants !== 2) yield annotated
    },
  )
  const work = priorityPairPlans(
    input,
    new Map(input.connections.map((c) => [c.name, ["bottom", "top"]])),
  )
  try {
    expect(work.next().value).toBe(preferred)
    expect(work.next().value).toBe(annotated)
    expect(work.next().done).toBe(true)
  } finally {
    work.return(undefined)
    stub.mockRestore()
  }
})

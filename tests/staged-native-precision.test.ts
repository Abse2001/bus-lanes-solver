import { expect, spyOn, test } from "bun:test"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import * as siteNegotiator from "../lib/negotiate-signal-sites"
import { routeFreshSurfaceBuses } from "../lib/route-fresh-surface-buses"
import type { SimpleRouteJson } from "../lib/types"

function fixture(): SimpleRouteJson {
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1016,
    minTraceToPadEdgeClearance: 0.1016,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    bounds: { minX: -3, maxX: 3, minY: -2, maxY: 2 },
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: -2, y: 0, layer: "top" },
          { x: 2, y: 0, layer: "top" },
        ],
      },
    ],
    buses: [{ busId: "data", connectionNames: ["D"], maxLengthSkew: 0.635 }],
    traces: [],
  }
}

function finish(work: ReturnType<typeof routeFreshSurfaceBuses>) {
  let next = work.next()
  try {
    for (let steps = 0; !next.done && steps < 10000; steps++) next = work.next()
    expect(next.done).toBe(true)
    return next.done ? next.value : null
  } finally {
    if (!next.done) work.return(null)
  }
}

for (const scenario of [
  "healthy",
  "precision",
  "carrier-then-precision",
] as const) {
  test(`${scenario}: precision is a failed-stage replay of the exact saved paired state`, () => {
    const input = fixture(),
      before = structuredClone(input)
    const original = siteNegotiator.negotiateSignalSites
    const calls: Array<{
      fine: boolean | undefined
      deferCarrier: boolean | undefined
    }> = []
    let saved: Parameters<typeof original>[0] | undefined
    let initialBytes: string | undefined
    const stub = spyOn(
      siteNegotiator,
      "negotiateSignalSites",
    ).mockImplementation(function* (...args) {
      if (!saved) {
        saved = args[0]
        initialBytes = JSON.stringify(saved)
      }
      expect(args[0]).toBe(saved)
      expect(JSON.stringify(args[0])).toBe(initialBytes!)
      calls.push({
        fine: args[4]?.allowFineNativeApproachRetry,
        deferCarrier: args[4]?.deferAlternateCarrierExpansion,
      })
      if (scenario === "precision" && calls.length === 1) {
        args[4]!.onSiteDomainFailure?.({
          kind: "empty-native-site-domain",
          connection: input.connections[0],
          searchComplete: true,
          budgetUnknown: false,
        })
        args[4]!.onDeferredFineNativeApproachRetry?.()
        return null
      }
      if (scenario === "carrier-then-precision" && calls.length < 3) {
        if (calls.length === 1) args[4]!.onDeferredCarrierExpansion?.()
        else args[4]!.onDeferredFineNativeApproachRetry?.()
        return null
      }
      return yield* original(...args)
    })
    try {
      const result = finish(
        routeFreshSurfaceBuses(
          input,
          input,
          [],
          new Map([["D", ["top", "bottom"]]]),
          { denseSearch: true, smoothTuning: true },
        ),
      )!
      expect(result).toBeTruthy()
      const validator = BusLanesSolver.forValidation(
        result.input,
        result.traces,
        { smoothTuning: true },
      )
      validator.solve()
      expect(validator.solved).toBe(true)
      expect(result.traces).toHaveLength(1)
      const output = validator.getOutput()
      // Carrier acceptance retains its two owned terminal approach records.
      expect(output.traces).toHaveLength(
        (result.input.traces?.length ?? 0) + result.traces.length,
      )
      expect(output.traces!.at(-1)?.connection_name).toBe("D")
      expect(calls).toEqual(
        scenario === "healthy"
          ? [{ fine: false, deferCarrier: true }]
          : scenario === "precision"
            ? [
                { fine: false, deferCarrier: true },
                { fine: true, deferCarrier: true },
              ]
            : [
                { fine: false, deferCarrier: true },
                { fine: false, deferCarrier: undefined },
                { fine: true, deferCarrier: undefined },
              ],
      )
      expect(input).toEqual(before)
    } finally {
      stub.mockRestore()
    }
  })
}

test("a failure without eligible deferred precision does not widen precision", () => {
  const input = fixture()
  const calls: boolean[] = []
  const stub = spyOn(siteNegotiator, "negotiateSignalSites").mockImplementation(
    function* (...args) {
      calls.push(args[4]?.allowFineNativeApproachRetry === true)
      return null
    },
  )
  try {
    expect(
      finish(routeFreshSurfaceBuses(input, input, [], new Map(), {})),
    ).toBeNull()
    expect(calls).toEqual([false])
  } finally {
    stub.mockRestore()
  }
})

test("a precision replay clears stale carrier eligibility from the earlier failed stage", () => {
  const input = fixture()
  const calls: boolean[] = []
  const stub = spyOn(siteNegotiator, "negotiateSignalSites").mockImplementation(
    function* (...args) {
      calls.push(args[4]?.allowFineNativeApproachRetry === true)
      if (calls.length === 1) {
        args[4]!.onDeferredFineNativeApproachRetry?.()
        args[4]!.onDeferredCarrierExpansion?.()
      }
      return null
    },
  )
  try {
    expect(
      finish(routeFreshSurfaceBuses(input, input, [], new Map(), {})),
    ).toBeNull()
    expect(calls).toEqual([false, true])
  } finally {
    stub.mockRestore()
  }
})

test("cancellation closes the current coarse child without scheduling a precision replay", () => {
  const input = fixture()
  let calls = 0,
    closed = false
  const stub = spyOn(siteNegotiator, "negotiateSignalSites").mockImplementation(
    function* () {
      calls++
      try {
        yield
        return null
      } finally {
        closed = true
      }
    },
  )
  const work = routeFreshSurfaceBuses(input, input, [], new Map(), {})
  try {
    expect(work.next().done).toBe(false)
    work.return(null)
    expect(closed).toBe(true)
    expect(calls).toBe(1)
  } finally {
    work.return(null)
    stub.mockRestore()
  }
})

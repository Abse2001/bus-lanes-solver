import { describe, expect, test } from "bun:test"
import {
  deriveLengthMatchingTargets,
  fixedPrefixLengthLowerBound,
  leastFeasibleLengthTargets,
  type LengthMatchingProblem,
} from "../lib/length-matching/targets"
import { evaluateLengthMatchingState } from "../lib/length-matching/objective"
import { LengthMatchingCheckpoint } from "../lib/length-matching/checkpoint"

const chain = (): LengthMatchingProblem => ({
  nets: [
    { name: "A", currentLengthMm: 10, lowerBoundMm: 10 },
    { name: "B", currentLengthMm: 10, lowerBoundMm: 0 },
    { name: "C", currentLengthMm: 8, lowerBoundMm: 0 },
  ],
  buses: [
    { busId: "AB", connectionNames: ["A", "B"], maxLengthSkew: 1 },
    {
      busId: "BC",
      connectionNames: ["B", "C"],
      maxLengthSkew: 1,
      maxLength: 10,
    },
    { busId: "Ccap", connectionNames: ["C"], maxLength: 8.5 },
  ],
})

describe("generic feasible matching targets", () => {
  test("native fixed and owned endpoint paths count once before Euclidean free-end lower bound", () => {
    expect(
      fixedPrefixLengthLowerBound({
        nativeFixedLengthMm: 2,
        fixedPrefixLengthMm: 3,
        freeEndpoints: [
          { x: 0, y: 0 },
          { x: 3, y: 4 },
        ],
      }),
    ).toBe(10)
    expect(() =>
      fixedPrefixLengthLowerBound({
        nativeFixedLengthMm: NaN,
        fixedPrefixLengthMm: 0,
        freeEndpoints: [
          { x: 0, y: 0 },
          { x: 3, y: 4 },
        ],
      }),
    ).toThrow()
  })
  test("overlapping groups propagate separately, preserving valid 10/9/8 chain", () => {
    expect(leastFeasibleLengthTargets(chain())).toEqual({
      feasible: true,
      targets: { A: 10, B: 9, C: 8 },
    })
    const impossible = chain()
    impossible.nets = impossible.nets.map((n) =>
      n.name === "C" ? { ...n, currentLengthMm: 7, fixedLength: true } : n,
    )
    expect(leastFeasibleLengthTargets(impossible).feasible).toBe(false)
  })
  test("immutable complete rails are fixed while their endpoint paths alone are not", () => {
    const problem: LengthMatchingProblem = {
      nets: [
        {
          name: "held",
          currentLengthMm: 4,
          lowerBoundMm: 1,
          fixedLength: true,
        },
        { name: "ordinary", currentLengthMm: 10, lowerBoundMm: 8 },
      ],
      buses: [
        {
          busId: "bus",
          connectionNames: ["held", "ordinary"],
          maxLengthSkew: 0.635,
        },
      ],
    }
    expect(deriveLengthMatchingTargets(problem).plans).toHaveLength(0)
    expect(
      deriveLengthMatchingTargets({
        ...problem,
        nets: problem.nets.map((n) => ({ ...n, fixedLength: false })),
      }).plans.length,
    ).toBeGreaterThan(0)
  })
  test("joint bus/pair windows intersect and every box corner honors all skew bounds", () => {
    const problem = chain()
    problem.differentialPairs = [
      { connectionNames: ["B", "C"], lengthTolerance: 0.127 },
    ]
    problem.buses = problem.buses!.filter((b) => b.busId !== "Ccap")
    const portfolio = deriveLengthMatchingTargets(problem)
    for (const plan of portfolio.plans) {
      for (const c of portfolio.constraints)
        if (c.tolerance !== undefined)
          for (const a of c.names)
            for (const b of c.names)
              expect(
                (plan.bands[a].maximum ?? Infinity) - plan.bands[b].minimum,
              ).toBeLessThanOrEqual(c.tolerance + 1e-7 + 1e-10)
      expect(plan.bands.B.minimum).toBeGreaterThanOrEqual(9)
    }
  })
  test("free diagnostic windows below immutable geometry are not planned", () => {
    const portfolio = deriveLengthMatchingTargets({
      nets: [
        { name: "far", currentLengthMm: 55, lowerBoundMm: 48 },
        { name: "near", currentLengthMm: 37, lowerBoundMm: 10 },
      ],
      buses: [
        {
          busId: "far-bus",
          connectionNames: ["far", "near"],
          maxLengthSkew: 0.635,
        },
      ],
    })
    expect(portfolio.plans.every((p) => p.bands.far.minimum >= 48)).toBe(true)
    expect(portfolio.plans.some((p) => p.id === "non-shortening")).toBe(true)
    expect(portfolio.shorteningPotential[0].potentialReductionMm).toBe(7)
  })
  test("absolute bounds and zero tolerance constrain all overlapping memberships", () => {
    const problem: LengthMatchingProblem = {
      nets: [
        { name: "A", currentLengthMm: 10, lowerBoundMm: 1 },
        { name: "B", currentLengthMm: 9, lowerBoundMm: 3 },
      ],
      buses: [
        { busId: "floor", connectionNames: ["A", "B"], minLength: 5 },
        { busId: "ceiling", connectionNames: ["A"], maxLength: 6 },
      ],
      differentialPairs: [{ connectionNames: ["A", "B"], lengthTolerance: 0 }],
    }
    expect(leastFeasibleLengthTargets(problem)).toEqual({
      feasible: true,
      targets: { A: 5, B: 5 },
    })
    expect(
      deriveLengthMatchingTargets(problem).failures.some(
        (f) => f.id === "non-shortening",
      ),
    ).toBe(true)
    const roundTrip = JSON.parse(
      JSON.stringify(deriveLengthMatchingTargets(problem)),
    )
    expect(roundTrip.plans[0].bands.B.maximum).toBe(5)
    const minOnly = deriveLengthMatchingTargets({
      nets: problem.nets,
      buses: [{ busId: "floor", connectionNames: ["A"], minLength: 5 }],
    })
    expect(
      JSON.parse(JSON.stringify(minOnly)).plans[0].bands.A.maximum,
    ).toBeNull()
    expect(minOnly.untimedNames).toEqual(["B"])
  })
  test("malformed memberships, numerical bounds, and requested names reject", () => {
    for (const names of [["A", "A"], ["missing"], []])
      expect(() =>
        deriveLengthMatchingTargets({
          ...chain(),
          buses: [{ busId: "bad", connectionNames: names, maxLengthSkew: 1 }],
        }),
      ).toThrow()
    for (const tolerance of [-1, NaN, Infinity])
      expect(() =>
        deriveLengthMatchingTargets({
          ...chain(),
          buses: [
            { busId: "bad", connectionNames: ["A"], maxLengthSkew: tolerance },
          ],
        }),
      ).toThrow()
    expect(() => leastFeasibleLengthTargets(chain(), { missing: 1 })).toThrow()
    expect(() =>
      deriveLengthMatchingTargets(chain(), { maximumPlans: 0 }),
    ).toThrow()
  })
  test("arbitrary native names never inherit requested values from Object.prototype", () => {
    const names = ["constructor", "toString", "__proto__"]
    const solved = leastFeasibleLengthTargets({
      nets: names.map((name) => ({
        name,
        currentLengthMm: 2,
        lowerBoundMm: 1,
      })),
    })
    expect(solved.feasible).toBe(true)
    if (solved.feasible)
      for (const name of names) expect(solved.targets[name]).toBe(1)
  })
  test("least closure agrees with exhaustive scalar assignments on bounded tiny problems", () => {
    let seed = 17
    const random = (limit: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed % limit
    }
    for (let trial = 0; trial < 48; trial++) {
      const lower = [random(5), random(5), random(5)]
      const upper = [random(5), random(5), random(5)]
      const tolerances = [random(3), random(3)]
      const tiny: LengthMatchingProblem = {
        nets: lower.map((value, index) => ({
          name: String(index),
          currentLengthMm: 4,
          lowerBoundMm: value,
        })),
        buses: [0, 1, 2].map((index) => ({
          busId: `cap${index}`,
          connectionNames: [String(index)],
          maxLength: upper[index],
        })),
        differentialPairs: [
          { connectionNames: ["0", "1"], lengthTolerance: tolerances[0] },
          { connectionNames: ["1", "2"], lengthTolerance: tolerances[1] },
        ],
      }
      const solutions: number[][] = []
      for (let a = 0; a <= 4; a++)
        for (let b = 0; b <= 4; b++)
          for (let c = 0; c <= 4; c++) {
            const values = [a, b, c]
            if (
              values.every(
                (value, index) =>
                  value >= lower[index] && value <= upper[index],
              ) &&
              Math.abs(a - b) <= tolerances[0] &&
              Math.abs(b - c) <= tolerances[1]
            )
              solutions.push(values)
          }
      const solved = leastFeasibleLengthTargets(tiny)
      expect(solved.feasible).toBe(solutions.length > 0)
      if (solved.feasible)
        for (let index = 0; index < 3; index++)
          expect(solved.targets[String(index)]).toBe(
            Math.min(...solutions.map((s) => s[index])),
          )
    }
  })
  test("native cap slack does not serialize an inverted held-net interval", () => {
    const p = deriveLengthMatchingTargets({
      nets: [
        {
          name: "held",
          currentLengthMm: 10,
          lowerBoundMm: 1,
          fixedLength: true,
        },
      ],
      buses: [
        { busId: "cap", connectionNames: ["held"], maxLength: 10 - 0.5e-7 },
      ],
    })
    expect(p.plans[0].bands.held).toEqual({ minimum: 10, maximum: 10 })
    const edge = deriveLengthMatchingTargets({
      nets: [
        {
          name: "held",
          currentLengthMm: 9,
          lowerBoundMm: 1,
          fixedLength: true,
        },
        {
          name: "other",
          currentLengthMm: 10.00000005,
          lowerBoundMm: 10.00000005,
        },
      ],
      buses: [
        { busId: "skew", connectionNames: ["held", "other"], maxLengthSkew: 1 },
      ],
    })
    expect(edge.plans[0].targets.held).toBe(9)
    expect(edge.plans[0].bands.held).toEqual({ minimum: 9, maximum: 9 })
    for (const bounds of [
      { minLength: 9.00000005 },
      { maxLength: 8.99999995 },
    ]) {
      const absolute = deriveLengthMatchingTargets({
        nets: [
          {
            name: "held",
            currentLengthMm: 9,
            lowerBoundMm: 1,
            fixedLength: true,
          },
        ],
        buses: [{ busId: "held-abs", connectionNames: ["held"], ...bounds }],
      })
      expect(absolute.plans[0].targets.held).toBe(9)
      expect(absolute.plans[0].bands.held).toEqual({ minimum: 9, maximum: 9 })
    }
  })
  test("native1e-7 boundary, missing measurement, and actual pair limit are honored", () => {
    const problem = {
      ...chain(),
      buses: [{ busId: "bus", connectionNames: ["A", "B"], maxLengthSkew: 1 }],
    }
    const p = deriveLengthMatchingTargets(problem)
    expect(
      evaluateLengthMatchingState(problem, p, {
        fullLengthsMm: { A: 10, B: 9 - 0.5e-7, C: 8 },
        totalWireLengthMm: 27,
        viaCount: 0,
      }).timingSolved,
    ).toBe(true)
    expect(
      evaluateLengthMatchingState(problem, p, {
        fullLengthsMm: { A: 10, B: 9 - 2e-7, C: 8 },
        totalWireLengthMm: 27,
        viaCount: 0,
      }).timingSolved,
    ).toBe(false)
    expect(() =>
      evaluateLengthMatchingState(problem, p, {
        fullLengthsMm: { A: 10 },
        totalWireLengthMm: 10,
        viaCount: 0,
      }),
    ).toThrow()
  })
})

type State = {
  lengths: Record<string, number>
  vias: number
  physical: boolean
  fixed: boolean
  mutate?: boolean
}
const problem: LengthMatchingProblem = {
  nets: [
    { name: "A", currentLengthMm: 10, lowerBoundMm: 1 },
    { name: "B", currentLengthMm: 1, lowerBoundMm: 1 },
    { name: "RESET", currentLengthMm: 2, lowerBoundMm: 1 },
  ],
  buses: [{ busId: "data", connectionNames: ["A", "B"], maxLengthSkew: 0.635 }],
}
const state = (a = 10, b = 1): State => ({
  lengths: { A: a, B: b, RESET: 2 },
  vias: 2,
  physical: true,
  fixed: true,
})
function checkpoint(
  options: {
    clock?: () => number
    validate?: (s: State) => any
    netFingerprint?: (s: State, name: string) => string
  } = {},
) {
  return new LengthMatchingCheckpoint(state(), {
    problem,
    portfolio: deriveLengthMatchingTargets(problem),
    measure: (s) => ({
      fullLengthsMm: s.lengths,
      totalWireLengthMm: Object.values(s.lengths).reduce((a, b) => a + b, 0),
      viaCount: s.vias,
    }),
    validate:
      options.validate ??
      ((s) => {
        if (s.mutate) s.lengths.A++
        return {
          physicalValid: s.physical,
          complete: true,
          fixedEscapesExact: s.fixed,
        }
      }),
    fingerprint: JSON.stringify,
    netFingerprint:
      options.netFingerprint ?? ((s, n) => JSON.stringify(s.lengths[n])),
    clock: options.clock,
  })
}
describe("transactional best checkpoint", () => {
  test("fully matched outside every frozen band beats a partial improvement and stops", () => {
    const c = checkpoint()
    expect(c.consider(state(10, 5)).accepted).toBe(true)
    const solved = c.consider(state(6, 6))
    expect(solved.accepted).toBe(true)
    expect(solved.evaluation.timingSolved).toBe(true)
    expect(solved.evaluation.outOfBandNames.length).toBeGreaterThan(0)
    expect(c.consider(state(10, 1)).accepted).toBe(false)
    expect(c.snapshot().best.lengths).toEqual({ A: 6, B: 6, RESET: 2 })
  })
  test("exception, timeout, validator rejection and mutation retain last best exactly", () => {
    let time = 0
    const c = checkpoint({ clock: () => time })
    c.consider(state(10, 5))
    const before = c.snapshot().best
    expect(
      c.transaction(() => {
        throw Error("bounded search failed")
      }).reason,
    ).toBe("exception")
    expect(
      c.transaction(
        () => {
          time = 10
          return state(6, 6)
        },
        { deadlineMs: 5 },
      ).reason,
    ).toBe("timeout")
    expect(c.consider({ ...state(6, 6), physical: false }).reason).toBe(
      "invalid",
    )
    expect(c.consider({ ...state(6, 6), fixed: false }).reason).toBe("invalid")
    expect(c.consider({ ...state(6, 6), mutate: true }).reason).toBe("mutation")
    expect(c.snapshot().best).toEqual(before)
  })
  test("a timeout during validation discards the otherwise improved candidate", () => {
    let time = 0,
      slow = false
    const c = checkpoint({
      clock: () => time,
      validate: () => {
        if (slow) time = 10
        return { physicalValid: true, complete: true, fixedEscapesExact: true }
      },
    })
    slow = true
    expect(c.consider(state(6, 6), { deadlineMs: 5 }).reason).toBe("timeout")
    expect(c.snapshot().best).toEqual(state())
  })
  test("external input/result/snapshot and rejected operator edits cannot mutate best or baseline", () => {
    const c = checkpoint()
    const next = state(10, 5),
      result = c.consider(next)
    next.lengths.B = 100
    result.best.lengths.B = 100
    const snapshot = c.snapshot()
    snapshot.best.lengths.B = 100
    snapshot.baseline.lengths.B = 100
    c.transaction((s) => {
      s.lengths.B = 100
      return null
    })
    expect(c.snapshot().best.lengths.B).toBe(5)
    expect(c.snapshot().baseline.lengths.B).toBe(1)
  })
  test("untimed RESET stays exact unless explicit physical reroute permission", () => {
    const c = checkpoint(),
      next = state(6, 6)
    next.lengths.RESET = 3
    expect(c.consider(next).reason).toBe("untimed-changed")
    expect(
      c.consider(next, { allowUntimedPhysicalReroute: true }).accepted,
    ).toBe(true)
    const following = state(6, 6)
    following.lengths.RESET = 3
    following.vias = 1
    expect(c.consider(following).accepted).toBe(true)
  })
  test("a native oracle timing rejection prevents solved status; invalid baseline rejects", () => {
    const c = checkpoint({
      validate: () => ({
        physicalValid: true,
        complete: true,
        fixedEscapesExact: true,
        timingValid: false,
      }),
    })
    expect(c.consider(state(6, 6)).evaluation.timingSolved).toBe(false)
    expect(() =>
      checkpoint({
        validate: () => ({
          physicalValid: false,
          complete: true,
          fixedEscapesExact: true,
        }),
      }),
    ).toThrow()
  })
  test("a protected-net fingerprint exception cannot partially commit", () => {
    const c = checkpoint({
      netFingerprint: (s, name) => {
        if (name === "RESET" && s.lengths.RESET === 3)
          throw Error("cannot fingerprint proposal")
        return JSON.stringify(s.lengths[name])
      },
    })
    const before = c.snapshot(),
      next = state(6, 6)
    next.lengths.RESET = 3
    expect(c.consider(next, { allowUntimedPhysicalReroute: true }).reason).toBe(
      "exception",
    )
    expect(c.snapshot().best).toEqual(before.best)
    expect(c.snapshot().evaluation).toEqual(before.evaluation)
  })
  test("complete held rails retain exact geometry independently of generic physical validation", () => {
    const heldProblem = {
      ...problem,
      nets: problem.nets.map((n) =>
        n.name === "A" ? { ...n, fixedLength: true } : n,
      ),
    }
    type HeldState = State & { shape?: string }
    const c = new LengthMatchingCheckpoint<HeldState>(state(), {
      problem: heldProblem,
      portfolio: deriveLengthMatchingTargets(heldProblem),
      measure: (s) => ({
        fullLengthsMm: s.lengths,
        totalWireLengthMm: 13,
        viaCount: s.vias,
      }),
      validate: () => ({
        physicalValid: true,
        complete: true,
        fixedEscapesExact: true,
      }),
      fingerprint: JSON.stringify,
      netFingerprint: (s, name) =>
        JSON.stringify([s.lengths[name], name === "A" ? s.shape : null]),
    })
    const next: HeldState = {
      ...state(10, 10),
      shape: "different-isometric-copper",
    }
    expect(c.consider(next, { allowUntimedPhysicalReroute: true }).reason).toBe(
      "fixed-net-changed",
    )
    expect(c.snapshot().best).toEqual(state())
  })
  test("infeasible configured timing bounds preserve a complete physical baseline", () => {
    const impossible: LengthMatchingProblem = {
      ...problem,
      buses: [
        {
          busId: "contradiction",
          connectionNames: ["A", "B"],
          minLength: 20,
          maxLength: 10,
        },
      ],
    }
    expect(leastFeasibleLengthTargets(impossible).feasible).toBe(false)
    const portfolio = deriveLengthMatchingTargets(impossible)
    expect(portfolio.plans).toEqual([])
    expect(portfolio.failures.length).toBeGreaterThan(0)
    const c = new LengthMatchingCheckpoint(state(), {
      problem: impossible,
      portfolio,
      measure: (s) => ({
        fullLengthsMm: s.lengths,
        totalWireLengthMm: 13,
        viaCount: s.vias,
      }),
      validate: () => ({
        physicalValid: true,
        complete: true,
        fixedEscapesExact: true,
      }),
      fingerprint: JSON.stringify,
      netFingerprint: (s, name) => JSON.stringify(s.lengths[name]),
    })
    expect(c.snapshot().evaluation.timingSolved).toBe(false)
    expect(c.snapshot().evaluation.actualConstraintFailures).toBeGreaterThan(0)
    expect(c.transaction(() => null).best).toEqual(state())
  })
})

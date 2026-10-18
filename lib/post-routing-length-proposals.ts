import { length } from "./geometry"
import { enumerateOrdinaryTwoViaLengthExcursions } from "./post-route-ordinary-length-excursions"
import { extendOrdinaryRouteLength } from "./post-route-ordinary-length-extensions"
import { enumeratePairedBodyLengthExtensions } from "./post-route-paired-length-extensions"
import type { PostRoutingLengthProposalFactory } from "./post-routing-length-tuning"
import { fixedRouteLength } from "./route-lengths"
import { shortenJoinedRouteFreeBody } from "./shorten-joined-route-free-body"
import type { SimpleRouteJson } from "./types"

/** Proposal operators are independent. The parent owns all adoption/rollback. */
export function defaultPostRoutingLengthProposalFactories(
  input: SimpleRouteJson,
): PostRoutingLengthProposalFactory[] {
  const paired = new Set(
    input.differentialPairs?.flatMap((pair) => pair.connectionNames),
  )
  const ordinary = input.connections.filter(
    (connection) => !paired.has(connection.name),
  )
  const shorteners = ordinary.map(
    (connection): PostRoutingLengthProposalFactory =>
      function* (context) {
        const band = context.plan.bands[connection.name]
        const old = context.traces.find(
          (trace) => trace.connection_name === connection.name,
        )
        if (!band || !old) return
        const fullLength =
          length(old.route) + fixedRouteLength(context.input, connection.name)
        const maximum = band.maximum ?? Infinity
        if (fullLength <= maximum + 1e-7) return
        const work = shortenJoinedRouteFreeBody(context.input, context.traces, {
          connectionName: connection.name,
          minimumLength: band.minimum,
          maximumLength: maximum,
          fixedEscapes: context.fixedEscapes,
          allowPartialProgress: true,
          maxCandidates: context.maximumCandidates,
          maxExpansions: 512,
          deadlineMs: context.deadlineMs,
        })
        try {
          let next = work.next()
          while (!next.done) {
            if (next.value)
              yield {
                replacements: [next.value.trace],
                operator: "shorten-free-body",
              }
            else yield undefined
            next = work.next()
          }
        } finally {
          work.return(undefined)
        }
      },
  )
  const pairExtensions: PostRoutingLengthProposalFactory[] = (
    input.differentialPairs ?? []
  ).map(
    (pair) =>
      function* (context) {
        const bands = pair.connectionNames.map(
          (name) => context.plan.bands[name],
        )
        if (bands.some((band) => !band)) return
        const minimum = Math.max(...bands.map((band) => band.minimum))
        const maximum = Math.min(
          ...bands.map((band) => band.maximum ?? Infinity),
        )
        if (!Number.isFinite(maximum) || maximum < minimum) return
        if (
          !pair.connectionNames.some((name) => {
            const trace = context.traces.find(
              (trace) => trace.connection_name === name,
            )
            return (
              trace &&
              length(trace.route) + fixedRouteLength(context.input, name) <
                minimum - 1e-7
            )
          })
        )
          return
        const work = enumeratePairedBodyLengthExtensions(
          context.input,
          context.traces,
          {
            connectionNames: pair.connectionNames,
            minimumLength: minimum,
            maximumLength: maximum,
            fixedEscapes: context.fixedEscapes,
            allowPartialProgress: true,
            maximumCandidates: Math.min(context.maximumCandidates, 256),
            maximumAttempts: 256,
            deadlineMs: context.deadlineMs,
          },
        )
        try {
          let next = work.next()
          while (!next.done) {
            if (next.value)
              yield {
                replacements: next.value.traces,
                operator: "extend-shared-pair",
              }
            else yield undefined
            next = work.next()
          }
        } finally {
          work.return(undefined)
        }
      },
  )
  const planarExtensions: PostRoutingLengthProposalFactory[] = ordinary.map(
    (connection) =>
      function* (context) {
        const band = context.plan.bands[connection.name]
        const trace = context.traces.find(
          (trace) => trace.connection_name === connection.name,
        )
        if (
          !band ||
          !trace ||
          length(trace.route) +
            fixedRouteLength(context.input, connection.name) >=
            band.minimum - 1e-7
        )
          return
        const work = extendOrdinaryRouteLength(context.input, context.traces, {
          connectionName: connection.name,
          minimumLength: band.minimum,
          maximumLength: band.maximum ?? Infinity,
          fixedEscapes: context.fixedEscapes,
          allowPartialProgress: true,
          maximumCandidates: context.maximumCandidates,
          maximumAttempts: 256,
          deadlineMs: context.deadlineMs,
        })
        try {
          let next = work.next()
          while (!next.done) {
            if (next.value)
              yield {
                replacements: [next.value.trace],
                operator: "extend-planar-zero-via",
              }
            else yield undefined
            next = work.next()
          }
        } finally {
          work.return(undefined)
        }
      },
  )
  const remoteExtensions: PostRoutingLengthProposalFactory[] = ordinary.map(
    (connection) =>
      function* (context) {
        const band = context.plan.bands[connection.name]
        const trace = context.traces.find(
          (trace) => trace.connection_name === connection.name,
        )
        if (!band || !trace || !Number.isFinite(band.maximum)) return
        if (
          length(trace.route) +
            fixedRouteLength(context.input, connection.name) >=
          band.minimum - 1e-7
        )
          return
        const work = enumerateOrdinaryTwoViaLengthExcursions(
          context.input,
          context.traces,
          {
            connectionName: connection.name,
            minimumLength: band.minimum,
            maximumLength: band.maximum!,
            fixedEscapes: context.fixedEscapes,
            allowPartialProgress: true,
            maximumCandidates: context.maximumCandidates,
            maximumAttempts: 256,
            maximumExpansions: 2000,
            deadlineMs: context.deadlineMs,
          },
        )
        try {
          let next = work.next()
          while (!next.done) {
            if (next.value)
              yield {
                replacements: [next.value.trace],
                operator: "extend-remote-two-via",
              }
            else yield undefined
            next = work.next()
          }
        } finally {
          work.return(undefined)
        }
      },
  )
  return [
    ...shorteners,
    ...pairExtensions,
    ...planarExtensions,
    ...remoteExtensions,
  ]
}

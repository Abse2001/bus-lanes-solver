import { length } from "./geometry"
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
  return input.connections
    .filter((connection) => !paired.has(connection.name))
    .map(
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
          const work = shortenJoinedRouteFreeBody(
            context.input,
            context.traces,
            {
              connectionName: connection.name,
              minimumLength: band.minimum,
              maximumLength: maximum,
              fixedEscapes: context.fixedEscapes,
              allowPartialProgress: true,
              maxCandidates: context.maximumCandidates,
              maxExpansions: 512,
              deadlineMs: context.deadlineMs,
            },
          )
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
            work.return()
          }
        },
    )
}

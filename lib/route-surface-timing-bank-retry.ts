import { finishSurfaceTiming } from "./finish-surface-timing"
import type { FlexibleSignalState } from "./flexible-signal-state"
import { length } from "./geometry"
import { joinSignalEscapes } from "./join-signal-escapes"
import {
  negotiateSurfaceRoutes,
  type SurfaceNegotiationOptions,
} from "./negotiate-surface-routes"
import { reserveGeneratedPairLengthBanks } from "./reserve-generated-pair-length-banks"
import {
  fixedRouteLength,
  maximumCarrierLength,
  minimumLengthTargets,
} from "./route-lengths"
import type { SolverOptions } from "./types"

/** A completed connectivity search reveals the actual bus-length demand.
 * Reserve that demand in common paired copper before rebuilding ordinary
 * paths. Temporary upper search bounds keep later detours inside the banks'
 * matching windows; they never replace the caller's native constraints. */
export function* routeSurfaceTimingBankRetry(
  previous: FlexibleSignalState,
  solverOptions: SolverOptions,
  negotiation: SurfaceNegotiationOptions = {},
  onConnectivityCheckpoint?: (state: FlexibleSignalState) => void,
): Generator<void, FlexibleSignalState | null> {
  const native = previous.native,
    paired = new Set(
      native.differentialPairs?.flatMap((pair) => pair.connectionNames),
    ),
    carriers = [...previous.retained, ...previous.traces],
    joined = carriers.map((trace) =>
      joinSignalEscapes(
        trace,
        previous.escapes.filter(
          (escape) => escape.connection_name === trace.connection_name,
        ),
      ),
    ),
    allTargets = minimumLengthTargets(native, joined),
    targets = new Map([...allTargets].filter(([name]) => paired.has(name))),
    originalPairs = carriers.filter((trace) =>
      paired.has(trace.connection_name!),
    ),
    banks = reserveGeneratedPairLengthBanks(
      native,
      originalPairs,
      previous.escapes,
      targets,
    )
  if (
    !banks ||
    banks.retained.every((trace, index) => trace === originalPairs[index])
  )
    return null
  yield
  const bankLengths = new Map(
      banks.retained.map((trace) => [
        trace.connection_name!,
        length(
          joinSignalEscapes(
            trace,
            banks.escapes.filter(
              (escape) => escape.connection_name === trace.connection_name,
            ),
          ).route,
        ) + fixedRouteLength(native, trace.connection_name!),
      ]),
    ),
    searchNative = {
      ...native,
      buses: native.buses?.map((bus) => {
        const anchors = bus.connectionNames.flatMap((name) => {
          const value = bankLengths.get(name)
          return value === undefined ? [] : [value]
        })
        return anchors.length && bus.maxLengthSkew !== undefined
          ? {
              ...bus,
              maxLength: Math.min(
                bus.maxLength ?? Infinity,
                Math.min(...anchors) + bus.maxLengthSkew,
              ),
            }
          : bus
      }),
    },
    ordinary = carriers.filter((trace) => {
      if (paired.has(trace.connection_name!)) return false
      const complete = joined.find(
        (item) => item.connection_name === trace.connection_name,
      )!
      return (
        length(complete.route) <=
        maximumCarrierLength(searchNative, trace.connection_name!) + 1e-7
      )
    }),
    ordinaryNames = new Set(ordinary.map((trace) => trace.connection_name)),
    escapes = [
      ...banks.escapes,
      ...previous.escapes.filter((escape) =>
        ordinaryNames.has(escape.connection_name),
      ),
    ],
    seed: FlexibleSignalState = {
      native: searchNative,
      retained: banks.retained,
      traces: ordinary,
      escapes,
      pending: {
        ...searchNative,
        traces: [...(native.traces ?? []), ...banks.retained, ...escapes],
      },
    },
    connected = yield* negotiateSurfaceRoutes(searchNative, seed, negotiation)
  if (!connected) return null
  const restored = {
    ...connected,
    native,
    pending: { ...connected.pending, buses: native.buses },
  }
  onConnectivityCheckpoint?.(restored)
  return (
    (yield* finishSurfaceTiming(restored, solverOptions, {
      preserveTiming: true,
    })) ?? (yield* finishSurfaceTiming(restored, solverOptions))
  )
}

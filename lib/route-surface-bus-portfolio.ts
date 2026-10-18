import {
  routeFreshSurfaceBuses,
  type SurfaceSeedOptions,
} from "./route-fresh-surface-buses"
import { routeJointSurfaceBuses } from "./route-joint-surface-buses"
import type { FlexibleSignalState } from "./flexible-signal-state"
import type { RepairedBusDogbones } from "./repair-bus-dogbones"
import type {
  SimpleRouteJson,
  SolverOptions,
  SurfaceRoutingStrategy,
  Trace,
} from "./types"

export type { SurfaceRoutingStrategy } from "./types"

export interface SurfaceBusPortfolioOptions extends SurfaceSeedOptions {
  strategy?: SurfaceRoutingStrategy
  goal?: "matched" | "physical"
  onConnectivityCheckpoint?: (state: FlexibleSignalState) => void
}

/** Large surface buses need whole-pad approach choices before fixing local
 * dogbones. Keep the compact-site search as a fallback, with the same native
 * geometry, matching requirements and aggregate parent work budget. */
export function* routeSurfaceBusPortfolio(
  native: SimpleRouteJson,
  allocation: SimpleRouteJson,
  escapes: Trace[],
  terminalLayers: ReadonlyMap<string, string[]>,
  options: SolverOptions,
  settings: SurfaceBusPortfolioOptions = {},
): Generator<void, RepairedBusDogbones | null> {
  const pairs = new Set(
    native.differentialPairs?.flatMap((pair) => pair.connectionNames),
  )
  const ordinaryCount = native.connections.filter(
    (connection) => !pairs.has(connection.name),
  ).length
  const jointFirst =
    settings.goal === "physical" ||
    settings.strategy === "joint" ||
    (settings.strategy !== "sites" &&
      native.allowedLayers?.length === 2 &&
      native.allowedLayers.includes("top") &&
      native.allowedLayers.includes("bottom") &&
      ordinaryCount > 24)
  if (jointFirst) {
    const joint = yield* routeJointSurfaceBuses(
      native,
      allocation,
      escapes,
      terminalLayers,
      options,
      {
        goal: settings.goal,
        onConnectivityCheckpoint: settings.onConnectivityCheckpoint,
        negotiation: {
          onProgress: (progress) =>
            settings.onProgress?.({
              stage: progress.stage === "complete" ? "matching" : "negotiate",
              connectionName: progress.connectionName,
              requestedSignals: native.connections.length,
              routedSignals: pairs.size + progress.mutuallyClearSignals,
              siteOptions: progress.candidates,
            }),
        },
        onProgress: (progress) => {
          if (progress.stage === "surface") return
          settings.onProgress?.({
            stage: progress.stage,
            connectionName: "",
            requestedSignals: native.connections.length,
            routedSignals:
              progress.stage === "matching"
                ? native.connections.length
                : progress.pairedSignals,
            siteOptions: progress.pairPlan,
          })
        },
      },
    )
    if (joint) return joint
    if (settings.goal === "physical") return null
  }
  return yield* routeFreshSurfaceBuses(
    native,
    allocation,
    escapes,
    terminalLayers,
    options,
    settings,
  )
}

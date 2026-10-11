import nativeInput from "../tests/fixtures/g350-am3352/native-input.json"
import metadata from "../tests/fixtures/g350-am3352/metadata.json"
import type { SimpleRouteJson } from "../lib"

export { metadata as g350Am3352Metadata }

/** Real pads, including NC and bottom-side support parts. No saved DDR paths.
 * The complete capture also retains the multi-terminal support nets; Bus Lanes
 * requires two-terminal connections, so those need a separate power/plane stage.
 */
export function loadG350Am3352Sample(): SimpleRouteJson {
  const input = structuredClone(nativeInput) as unknown as SimpleRouteJson
  input.allowedLayers = ["top", "bottom"]
  input.connections = input.connections.filter(
    (c) => c.name in metadata.signalNames,
  )
  return input
}

export function loadG350Am3352CompleteInput(): SimpleRouteJson {
  return structuredClone(nativeInput) as unknown as SimpleRouteJson
}

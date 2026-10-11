export const DEFAULT_TIMEOUT_SECONDS = 3600
export const MAX_TIMEOUT_SECONDS = 3600

/** Only accept a duration, never shell arguments, paths or sample selectors. */
export function parseBenchmarkCommand(body) {
  const command = body.trim()
  if (!/^\/benchmark(?:\s|$)/.test(command)) return null
  const args = command.split(/\s+/).slice(1)
  if (!args.length) return { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS }
  if (
    args.length !== 2 ||
    args[0] !== "--timeout-seconds" ||
    !/^\d+$/.test(args[1])
  )
    throw Error("Use /benchmark [--timeout-seconds <1..3600>]")
  const timeoutSeconds = Number(args[1])
  if (
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS
  )
    throw Error("The per-sample timeout must be between 1 and 3600 seconds")
  return { timeoutSeconds }
}

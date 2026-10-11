export const DEFAULT_TIMEOUT_SECONDS: number
export const MAX_TIMEOUT_SECONDS: number
export function parseBenchmarkCommand(
  body: string,
): { timeoutSeconds: number } | null

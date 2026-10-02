/** Keep child searches cancellable and charge every yield to the parent. */
export function* runBoundedRouting<T>(
  generator: Generator<unknown, T>,
  limit: number,
): Generator<void, T | null> {
  let state = generator.next()
  let steps = 0
  try {
    while (!state.done && steps++ < limit) {
      yield
      state = generator.next()
    }
    return state.done ? state.value : null
  } finally {
    if (!state.done) generator.return(null as T)
  }
}

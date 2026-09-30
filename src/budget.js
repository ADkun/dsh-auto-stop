/**
 * How much output room one model call actually has.
 *
 * The ceiling reaches a plugin three ways, in decreasing authority:
 *
 * 1. `options.maxTokens` — the frozen per-request cap on the call being made.
 * 2. the owning agent's own `maxTokens` option — what the loop asked for when
 *    the adapter supplied no default of its own.
 * 3. the model's disclosed `defaultMaxTokens` — "adapter-configured
 *    per-request output cap materialized when callers omit one". `dsh-llm`
 *    itself resolves exactly this when a call carries no `maxTokens`.
 *
 * @module dsh-auto-stop/budget
 */

/**
 * Read a value that has to be a usable token count.
 *
 * @param {unknown} value - a candidate ceiling.
 * @returns {number | undefined} the value, or `undefined` when it is not a
 * positive integer.
 */
export function readPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Turn one disclosed output ceiling into the estimate at which to stop.
 *
 * The reserve is what keeps an early cut *early* rather than too late: it
 * absorbs the estimator's error, the tokens the provider counts but no delta
 * ever carries, and the few chunks a clean close needs. A ceiling too small to
 * hold a useful reserve is left alone entirely — cutting a 200-token answer in
 * half helps nobody.
 *
 * @param {unknown} budget - the call's output ceiling, if it has one.
 * @param {{ reserveRatio: number, reserveMin: number, minBudget: number }} config
 * - the resolved options.
 * @returns {number | undefined} the cutoff in estimated output tokens, or
 * `undefined` when this call should not be guarded.
 */
export function resolveCutoff(budget, config) {
  const ceiling = readPositiveInteger(budget)
  if (ceiling === undefined) return undefined
  if (ceiling < config.minBudget) return undefined
  const reserve = Math.max(config.reserveMin, Math.round(ceiling * config.reserveRatio))
  const limit = Math.floor(ceiling - reserve)
  return limit >= 1 ? limit : undefined
}
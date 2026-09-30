/**
 * dsh-auto-stop — end a response just before it reaches its output ceiling.
 *
 * ## What it does
 *
 * DSH stops a response at the model's output ceiling by itself, but it stops it
 * *at* the ceiling: the tail is what gets cut, the turn ends, and getting the
 * rest of the answer requires someone to notice and ask for it. This plugin
 * moves the stop a little earlier and makes the follow-up automatic.
 *
 * 1. It learns the ceiling of the call being made — the request's frozen
 *    `maxTokens`, else the owning agent's own option, else the adapter's
 *    disclosed `defaultMaxTokens`.
 * 2. It meters the response as it streams, and once the estimate reaches
 *    `ceiling - reserve` it closes the open blocks and emits the harness's own
 *    terminal `{ kind: 'max-tokens' }`. The turn ends exactly the way DSH ends a
 *    truncated turn: partial message committed, tool calls dropped, chat notice
 *    shown, conversation waiting for "继续".
 * 3. When the agent that ran out of room is a *subagent*, it steers a two-line
 *    notice into its parent agent naming the exact `send_message` call that
 *    continues it. A background child cannot ask for its own continuation, and
 *    its parent is the only agent that can.
 *
 * ## Why the stream is the right place
 *
 * `llm/stream` is a waterfall wrapping every streaming model call — the agent
 * loop's, a retry's, a replay's. A single listener there sees each response as
 * it is produced, knows which session it belongs to (`options.sessionId` is the
 * owning session, not the caller's), and can end it without touching the loop.
 *
 * ## Why the parent hand-off also covers the provider's own cut
 *
 * The estimator is a heuristic, and a model whose ceiling is never disclosed is
 * never guarded at all. So the guard reports the provider's own `max-tokens`
 * finish through the same path: a child that hit the real ceiling still gets its
 * parent told to continue it, and the hand-off does not depend on the estimate
 * being right.
 *
 * @module dsh-auto-stop
 */

import { readPositiveInteger, resolveCutoff } from './budget.js'
import { normalizeConfig } from './config.js'
import { guardStream } from './cutoff.js'
import { estimateText } from './estimate.js'
import { isDelegatedChild, parentSessionIdOf } from './lineage.js'
import { createNotice, truncationNotice } from './notify.js'
import { Config, readConfig } from './settings.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-auto-stop'

export { Config }

/**
 * Scope bypass for a standing listener.
 *
 * DSH dispatches events through a scope carrier and Cordis drops any listener
 * whose own context is not in that carrier's chain, so a plugin that has to see
 * *every* conversation's model calls asks for global delivery explicitly.
 */
const GLOBAL = Object.freeze({ global: true })

/** Read a message out of an unknown thrown value. */
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Install the cutoff and the parent hand-off.
 *
 * @param {object} ctx - the plugin context the Loader composed this row into.
 * @param {unknown} rawConfig - the row's resolved `config:` block.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  /**
   * Re-read the row's configuration before each model call.
   *
   * Volatile fields arrive as stable references the Loader rewrites in place
   * when a form saves a value, so reading them once at activation would make
   * every field in the Plugins page look live while behaving as fixed.
   */
  const readOptions = () => normalizeConfig(readConfig(rawConfig))

  /** Report through the harness logger; logging itself is never fatal. */
  const report = (level, line) => {
    try {
      ctx.logger?.[level]?.(`[dsh-auto-stop] ${line}`)
    } catch {
      /* a logger that is absent or unhappy must not affect a response */
    }
  }

  // Services are adopted late and optionally: a patch-inserted row can activate
  // before the row that publishes the service it needs.
  let llm = ctx.get('llm')
  ctx.inject(['llm'], (serviceCtx) => {
    llm = serviceCtx.llm
  })
  let agents = ctx.get('agents')
  ctx.inject(['agents'], (serviceCtx) => {
    agents = serviceCtx.agents
  })

  /** Disclosed output ceilings, keyed by provider and model. */
  const disclosed = new Map()

  /** Models already reported as having no ceiling to meter against. */
  const unarmed = new Set()

  /**
   * Say once per model that there is no ceiling to meter against.
   *
   * Silence is the one thing this must not do: the early cutoff would simply
   * never happen, and nothing in the transcript would say why. The first reason
   * found for a model is the one worth printing, so later ones are folded in.
   *
   * @param {unknown} provider - the call's provider name.
   * @param {unknown} model - the call's model name.
   * @param {string} detail - why there was no ceiling.
   * @returns {void}
   */
  function reportUnarmed(provider, model, detail) {
    const key = `${provider}\u0000${model}`
    if (unarmed.has(key)) return
    unarmed.add(key)
    report('warn', `no output ceiling for ${provider}/${model}: ${detail}`)
  }

  /** Resolve one session's live agent, when it is still registered. */
  function agentFor(sessionId) {
    if (sessionId === undefined || sessionId === null || agents === undefined) return undefined
    try {
      return agents.get(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Ask the adapter for a model's own output ceiling.
   *
   * `defaultMaxTokens` is the per-request cap the adapter materializes when a
   * caller omits one, which is exactly the number a guarded call would run
   * under. Resolution is cached per model: it can cost a discovery round trip,
   * and a failure is deliberately not cached so a transient one can recover. Its
   * report is cached, so a route that is unreachable for an hour writes one line.
   */
  async function disclosedMaxTokens(provider, model, signal) {
    if (llm === undefined || typeof provider !== 'string' || typeof model !== 'string') return undefined
    const key = `${provider}\u0000${model}`
    const known = disclosed.get(key)
    if (known !== undefined) return known
    try {
      const info = await llm.resolveModelInfo(provider, model, signal)
      const value = readPositiveInteger(info?.defaultMaxTokens)
      if (value === undefined) return undefined
      disclosed.set(key, value)
      report('info', `${provider}/${model} reports a ${value}-token output ceiling`)
      return value
    } catch (error) {
      reportUnarmed(provider, model, reasonOf(error))
      return undefined
    }
  }

  /**
   * Resolve the output ceiling of one call.
   *
   * The order matches the harness's own: the frozen request wins, then what the
   * loop asked its agent for, then what the adapter would have materialized.
   */
  async function outputBudget(options) {
    const requested = readPositiveInteger(options?.maxTokens)
    if (requested !== undefined) return requested
    const owned = readPositiveInteger(agentFor(options?.sessionId)?.options?.maxTokens)
    if (owned !== undefined) return owned
    return await disclosedMaxTokens(options?.provider, options?.model, options?.signal)
  }

  /**
   * Hand one child that ran out of room back to its parent agent.
   *
   * Only a delegated child has a parent to tell: a root conversation's audience
   * is the user, who already gets DSH's own truncation notice, and a
   * `subagent_fork` is an independent conversation that merely shares lineage.
   */
  function notifyParent(config, options, tokens, reason) {
    if (!config.notifyParent) return
    const session = agentFor(options?.sessionId)?.session
    const header = session?.header
    if (!isDelegatedChild(header)) return
    const parentId = parentSessionIdOf(header)
    const childId = String(session?.id ?? options?.sessionId)
    const parent = agentFor(parentId)
    if (parent === undefined || typeof parent.steer !== 'function') {
      report(
        'warn',
        `child ${childId} ran out of room (${reason}) but parent ${parentId} is not live; ` +
          'only the settlement notice can carry the continuation',
      )
      return
    }
    try {
      parent.steer(createNotice(truncationNotice(config, childId, tokens)))
      report(
        'info',
        `child ${childId} stopped at ~${Math.round(tokens)} estimated output tokens (${reason}); ` +
          `told parent ${parentId} to continue it`,
      )
    } catch (error) {
      report('warn', `could not hand child ${childId} back to ${parentId}: ${reasonOf(error)}`)
    }
  }

  ctx.on(
    'llm/stream',
    (options, next) =>
      // The downstream chain starts on the first pull, so resolving the ceiling
      // here — possibly over the network — adds no latency to anything else.
      (async function* guarded() {
        const config = readOptions()
        if (!config.enabled || options?.purpose !== undefined) {
          yield* next()
          return
        }
        // No ceiling is not a number to invent: the response is passed through
        // exactly as the harness would have sent it, and the operator is told
        // once per model. A ceiling that is merely too small to hold a reserve is
        // a decision this plugin already made in `resolveCutoff`, not a warning.
        const budget = await outputBudget(options)
        const limit = resolveCutoff(budget, config)
        if (limit === undefined) {
          if (budget === undefined) {
            reportUnarmed(
              options?.provider,
              options?.model,
              'standing aside (declare maxTokens on the model entry to arm the early cutoff)',
            )
          }
          yield* next()
          return
        }
        yield* guardStream(next(), {
          limit,
          estimate: (text) => estimateText(text, config),
          onCut: (used, reason) => notifyParent(config, options, used, reason),
        })
      })(),
    GLOBAL,
  )

  report('info', 'armed: responses end just before their output ceiling, and a truncated child is handed back to its parent')
}

export default { name, apply, Config }
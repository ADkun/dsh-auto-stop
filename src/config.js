/**
 * Configuration normalization for dsh-auto-stop.
 *
 * The Cordis `Config` schema lives in `./settings.js`; this module is the second
 * line of defence. It rejects nothing and validates nothing, so a value that
 * reached the plugin anyway — an older row, a hand-edited patch — falls back to
 * its default instead of failing the profile load.
 *
 * @module dsh-auto-stop/config
 */

/** Every option with its default, as one frozen reference object. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch; checked before every model call, so `false` disarms the
   * plugin without unmounting it or taking its listener down. */
  enabled: true,

  /**
   * How much of the output ceiling to leave unused, as a fraction.
   *
   * The cutoff fires at `budget - max(reserveMin, budget * reserveRatio)`. The
   * reserve pays for the estimator's own error, for the block-closing chunks,
   * and for whatever the provider counts that this plugin cannot see.
   */
  reserveRatio: 0.05,

  /** The reserve's floor, in tokens, for models with a small ceiling. */
  reserveMin: 256,

  /**
   * Characters per token for text outside the CJK ranges.
   *
   * DSH's own estimator uses a flat 4 chars/token. 3.5 is deliberately a
   * little pessimistic: ending a response a few hundred tokens early is
   * harmless, while overshooting the real ceiling is exactly what this plugin
   * exists to avoid.
   */
  charsPerToken: 3.5,

  /**
   * Tokens per character inside the CJK ranges.
   *
   * CJK text is the reason a flat character count cannot be trusted: one
   * ideograph costs roughly one token, not a quarter of one.
   */
  cjkTokensPerChar: 0.8,

  /** Below this output ceiling the plugin does not intervene at all. */
  minBudget: 1024,

  /**
   * Hand a truncated child turn back to its parent agent.
   *
   * `true` steers one model-facing notice into the parent, naming the child and
   * the exact `send_message` call that continues it. `false` keeps the cut and
   * leaves the hand-off to DSH's own settlement notice.
   */
  notifyParent: true,

  /**
   * The notice delivered to the parent agent when a child was cut off.
   *
   * Placeholders: `{agentId}` (the child's session id), `{continueMessage}`,
   * `{tokens}` (the estimate at the moment of the cut). Kept to two lines on
   * purpose — it competes with the parent's own task for attention.
   */
  parentPrompt: '[dsh-auto-stop] 子代理 {agentId} 输出触顶被中断（约 {tokens} tokens）。\n立即发送：send_message(agent_id="{agentId}", message="{continueMessage}")',

  /** The text the parent is told to send back to the truncated child. */
  continueMessage: '继续（从断点接着写，不要重复已写内容）',
})

/** @returns {boolean} whether `value` is a plain object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a boolean, falling back when the value is absent or of another type. */
function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Read a finite number, falling back when the value is absent or invalid. */
function readNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Clamp `value` into `[min, max]`. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Read a non-empty trimmed string, or `undefined` when there is none. */
function readText(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Normalize one raw `config:` block into a complete option object.
 *
 * @param {unknown} raw - the row's configuration, live values already resolved.
 * @returns {typeof DEFAULT_CONFIG} every option resolved to a usable value.
 */
export function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  return {
    enabled: readBoolean(input.enabled, DEFAULT_CONFIG.enabled),
    reserveRatio: clamp(readNumber(input.reserveRatio, DEFAULT_CONFIG.reserveRatio), 0, 0.5),
    reserveMin: clamp(Math.round(readNumber(input.reserveMin, DEFAULT_CONFIG.reserveMin)), 0, 1_000_000),
    charsPerToken: clamp(readNumber(input.charsPerToken, DEFAULT_CONFIG.charsPerToken), 0.5, 16),
    cjkTokensPerChar: clamp(readNumber(input.cjkTokensPerChar, DEFAULT_CONFIG.cjkTokensPerChar), 0.1, 4),
    minBudget: clamp(Math.round(readNumber(input.minBudget, DEFAULT_CONFIG.minBudget)), 1, 10_000_000),
    notifyParent: readBoolean(input.notifyParent, DEFAULT_CONFIG.notifyParent),
    parentPrompt: readText(input.parentPrompt) ?? DEFAULT_CONFIG.parentPrompt,
    continueMessage: readText(input.continueMessage) ?? DEFAULT_CONFIG.continueMessage,
  }
}
/**
 * The hand-off that follows a truncated child turn.
 *
 * A plugin cannot reach DSH's own delivery helpers: `ctx.subagents.sendMessage`
 * requires the exact live *model*, admitting sender, and the child is the one
 * being spoken about, not the one speaking. What a plugin can do is the
 * underlying primitive — splice one model-facing message into an agent's inbox
 * and wake it — which is exactly what `Agent.steer(message)` is:
 *
 * ```js
 * steer(input) { this.send(input, 'next-step', true) }
 * ```
 *
 * A steered message is model-facing and waking: it reaches the nearest step
 * boundary of a running agent, and an idle agent's driver starts a turn for it.
 * So the parent reads the notice as an instruction it is expected to act on,
 * and its own `send_message` back to the child either steers the live child or
 * cold-resumes the settled one — every case the hand-off needs.
 *
 * Messages are built here by hand rather than with `createUserMessage`. Plugin
 * code may not import `@deepseek-ai/*` at runtime: harness packages ship inside
 * DSH's own tree and are not resolvable from an installed profile. The shape
 * below is that helper's output, minus a brand that exists only in the types.
 *
 * @module dsh-auto-stop/notify
 */

import { randomUUID } from 'node:crypto'

/** Freeze `value` and everything reachable from it. */
function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested)
  return value
}

/**
 * Build one model-facing user message.
 *
 * @param {string} text - the message body.
 * @returns {object} a frozen `UserMessage`-shaped value, safe to hand to
 * `Agent.steer`.
 */
export function createNotice(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * Substitute `{name}` placeholders in one configured template.
 *
 * Unknown placeholders are left verbatim: a typo in a form field should show up
 * in the notice, not silently vanish from it.
 *
 * @param {unknown} template - the configured template.
 * @param {Record<string, unknown>} values - the replacements.
 * @returns {string} the rendered text.
 */
export function renderTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  )
}

/**
 * Render the notice a parent agent receives when its child was cut off.
 *
 * @param {{ parentPrompt: string, continueMessage: string }} config - the
 * resolved options.
 * @param {string} agentId - the truncated child's session id.
 * @param {number} tokens - the estimate at the moment of the cut.
 * @returns {string} the notice text.
 */
export function truncationNotice(config, agentId, tokens) {
  return renderTemplate(config.parentPrompt, {
    agentId,
    tokens: String(Math.round(tokens)),
    continueMessage: config.continueMessage,
  })
}
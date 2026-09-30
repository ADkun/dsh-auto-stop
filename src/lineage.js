/**
 * Conversation lineage, read the way DSH records it.
 *
 * @module dsh-auto-stop/lineage
 */

/**
 * Read whether one session header names a delegated child.
 *
 * Both halves matter. A `subagent_fork` shares its `parentSession` with the
 * conversation it was forked from, but carries no `origin`, and is an
 * independent conversation: notifying that "parent" would steer an unrelated
 * agent. Only a genuine delegation has both fields.
 *
 * @param {unknown} header - a `SessionHeader`, or anything else.
 * @returns {boolean} whether the header belongs to a delegated child.
 */
export function isDelegatedChild(header) {
  return (
    typeof header === 'object' &&
    header !== null &&
    /** @type {{ origin?: unknown, parentSession?: unknown }} */ (header).origin === 'subagent' &&
    /** @type {{ parentSession?: unknown }} */ (header).parentSession !== undefined &&
    /** @type {{ parentSession?: unknown }} */ (header).parentSession !== null
  )
}

/**
 * Resolve the session that delegated `header`, when there is one.
 *
 * @param {unknown} header - a `SessionHeader`, or anything else.
 * @returns {string | undefined} the parent's session id, or `undefined` for a
 * root conversation, a fork, or a header that names no parent.
 */
export function parentSessionIdOf(header) {
  return isDelegatedChild(header)
    ? String(/** @type {{ parentSession: unknown }} */ (header).parentSession)
    : undefined
}
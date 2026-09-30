/**
 * Stream metering: count a response as it arrives, and end it early when the
 * estimate reaches the cutoff.
 *
 * ## Why the cut is synthesized rather than aborted
 *
 * DSH already treats a `max-tokens` finish as a first-class turn ending: the
 * agent loop commits the partial assistant message, latches the reason, and
 * skips tool dispatch — under `max-tokens`, `BlockAssembler.assembled()` drops
 * tool-call blocks precisely because they cannot be executed safely. Emitting
 * that same terminal chunk ourselves therefore reuses the harness's own
 * truncation path end to end (turn end, durable log, chat notice, subagent stop
 * reason) instead of inventing a parallel one.
 *
 * ## Why every open block is closed by hand
 *
 * The package-owned LLM stream invariant rejects a stream that terminates while
 * blocks are still open, except for `error` and `aborted`:
 *
 * ```js
 * case "finish":
 *   if (open.size > 0 && chunk.reason.kind !== "error" && chunk.reason.kind !== "aborted")
 *     fail(`LLM stream finished with ${open.size} open block(s)`);
 * ```
 *
 * A provider that truncates normally still closes its blocks first, so the cut
 * has to do the same: accumulate each open block well enough to close it, then
 * emit one `block-end` per open index before the synthetic finish.
 *
 * @module dsh-auto-stop/cutoff
 */

/** One open block's accumulated form, enough to close it by hand. */
function openBlock(blockType) {
  return {
    blockType,
    text: '',
    toolCallId: undefined,
    toolCallName: undefined,
    toolCallArguments: '',
  }
}

/**
 * Fold one chunk into the tracked open-block map.
 *
 * @param {Map<number, ReturnType<typeof openBlock>>} open - the live blocks.
 * @param {object} chunk - the raw chunk, in stream order.
 * @returns {void}
 */
export function observeChunk(open, chunk) {
  switch (chunk.type) {
    case 'block-start':
      if (!open.has(chunk.index)) open.set(chunk.index, openBlock(chunk.blockType))
      return
    case 'text-delta':
    case 'reasoning-delta': {
      const block = open.get(chunk.index)
      if (block !== undefined) block.text += chunk.text ?? ''
      return
    }
    case 'tool-call-delta': {
      const block = open.get(chunk.index)
      if (block === undefined) return
      if (chunk.id !== undefined) block.toolCallId = chunk.id
      if (chunk.name !== undefined && chunk.name !== '') block.toolCallName = chunk.name
      block.toolCallArguments += chunk.argumentsDelta ?? ''
      return
    }
    case 'block-end':
      open.delete(chunk.index)
      return
    default:
      return
  }
}

/**
 * Assemble the block that closes one tracked index.
 *
 * The closed form is exactly the one `block-end` carries, so the assembler
 * downstream cannot tell a hand-closed block from a provider-closed one. Tool
 * call ids and names default to the same values the assembler itself would
 * invent for an unterminated block.
 *
 * @param {number} index - the block's stream index.
 * @param {ReturnType<typeof openBlock>} block - its accumulated form.
 * @returns {object | undefined} the block to close with, or `undefined` for a
 * block type this plugin cannot reconstruct.
 */
export function closeBlock(index, block) {
  if (block.blockType === 'text') return { type: 'text', text: block.text }
  if (block.blockType === 'reasoning') return { type: 'reasoning', text: block.text }
  if (block.blockType === 'tool-call') {
    return {
      type: 'tool-call',
      id: block.toolCallId ?? `call-${index}`,
      name: block.toolCallName ?? '',
      arguments: block.toolCallArguments,
    }
  }
  return undefined
}

/**
 * Estimate the output tokens one streamed chunk adds.
 *
 * Only model-authored content counts: reasoning deltas are billed as output
 * just like visible text, and a tool call's name and arguments are generated
 * too. Block markers, usage and finish chunks add no output of their own.
 *
 * @param {object} chunk - one raw chunk.
 * @param {(text: unknown) => number} estimate - the text estimator.
 * @returns {number} the chunk's estimated output tokens.
 */
export function outputTokensOf(chunk, estimate) {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return estimate(chunk.text)
    case 'tool-call-delta':
      return estimate(chunk.name) + estimate(chunk.argumentsDelta)
    default:
      return 0
  }
}

/**
 * Wrap one adapter stream so it ends early instead of overrunning its ceiling.
 *
 * Two events are reported through `onCut`, and both mean the same thing to the
 * caller: this response stopped because it ran out of output room. `guarded`
 * means this wrapper stopped it; `truncated` means the provider did, which is
 * what happens whenever the estimate ran low or the ceiling was not disclosed.
 * Detecting both here is what keeps the parent hand-off working even when the
 * early cutoff never gets the chance to fire.
 *
 * @param {AsyncIterable<object>} source - the downstream chunk stream.
 * @param {object} options - the guard's configuration.
 * @param {number} options.limit - the estimated output-token cutoff.
 * @param {(text: unknown) => number} options.estimate - the text estimator.
 * @param {(used: number, reason: 'guarded' | 'truncated') => void} [options.onCut]
 * - called at most once, before the response's real terminal state is visible.
 * @yields {object} the same chunks, plus the cut's own closures and finish.
 * @returns {AsyncGenerator<object>} the guarded stream.
 */
export async function* guardStream(source, { limit, estimate, onCut }) {
  const open = new Map()
  // Pulled by hand rather than with `for await`, so that closing the source can
  // be made harmless. An abrupt `return` out of a `for await` loop calls the
  // source's own `.return()`, and a provider stream whose teardown throws would
  // then surface as a stream *error* — replacing the clean truncation this
  // wrapper just produced with the failure it exists to avoid.
  const sourceIterator = source[Symbol.asyncIterator]()
  let used = 0
  let announced = false
  let closed = false

  /** Report the cut once; a failed hand-off must never break the response. */
  const announce = (reason) => {
    if (announced) return
    announced = true
    try {
      onCut?.(used, reason)
    } catch {
      /* the response is already ending; reporting is best-effort */
    }
  }

  /** Stop reading the source, tolerating a transport that fails to close. */
  const stopReading = async () => {
    if (closed) return
    closed = true
    try {
      await sourceIterator.return?.()
    } catch {
      /* the answer is over either way; teardown noise is not an answer error */
    }
  }

  try {
    while (true) {
      const step = await sourceIterator.next()
      if (step.done === true) return
      const chunk = step.value
      observeChunk(open, chunk)
      if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'max-tokens') announce('truncated')
        closed = true
        yield chunk
        return
      }
      yield chunk
      used += outputTokensOf(chunk, estimate)
      if (used < limit) continue
      announce('guarded')
      for (const [index, block] of open) {
        const assembled = closeBlock(index, block)
        if (assembled !== undefined) yield { type: 'block-end', index, block: assembled }
      }
      await stopReading()
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
  } finally {
    // Reached when the consumer stops early (an abort, a retry): release the
    // provider stream instead of leaving it running for an answer nobody wants.
    await stopReading()
  }
}
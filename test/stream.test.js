/**
 * Tests for the stream guard.
 *
 * `assertGrammar` is a local copy of the harness's own stream invariant
 * (`@deepseek-ai/dsh-llm/lib/invariant.js`, `validateStream`, lines 19-60),
 * which is installed around *every* provider stream and therefore around this
 * plugin's output. The copy is deliberate: this repository has no
 * `node_modules`, and the one thing a synthetic stream must never do is fail
 * the real validator. Keep the two in step — in particular the rule that a
 * non-error finish may not leave a block open.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { guardStream, observeChunk, outputTokensOf } from '../src/cutoff.js'
import { estimateText } from '../src/estimate.js'
import { normalizeConfig } from '../src/config.js'

/** The estimator the plugin runs with by default. */
const CONFIG = normalizeConfig({})

/** @returns {number} the estimate for one piece of text, at default settings. */
const estimate = (text) => estimateText(text, CONFIG)

/**
 * A stream of chunks, optionally recording that it was torn down.
 *
 * @param {object[]} chunks - the chunks to emit.
 * @param {{closed?: boolean}} [state] - set when the source is closed.
 * @returns {AsyncGenerator<object>} the source stream.
 */
async function* emit(chunks, state) {
  try {
    for (const chunk of chunks) yield chunk
  } finally {
    if (state !== undefined) state.closed = true
  }
}

/**
 * A source whose teardown throws, the way a provider stream can when a body is
 * abandoned mid-flight.
 *
 * @param {object[]} chunks - the chunks to emit.
 * @returns {AsyncGenerator<object>} the source stream.
 */
async function* emitThenFail(chunks) {
  try {
    for (const chunk of chunks) yield chunk
  } finally {
    throw new Error('teardown failed')
  }
}

/** @returns {Promise<object[]>} every chunk of `stream`, in order. */
async function collect(stream) {
  const seen = []
  for await (const chunk of stream) seen.push(chunk)
  return seen
}

/** One text block, streamed as `count` deltas and closed by the provider. */
function textStream(count, onFinally) {
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }]
  for (let i = 0; i < count; i += 1) chunks.push({ type: 'text-delta', index: 0, text: 'a'.repeat(35) })
  chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'a'.repeat(35 * count) } })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return emit(chunks, onFinally)
}

/**
 * Assert the harness's stream grammar over `chunks`.
 *
 * @param {object[]} chunks - the chunks a consumer saw.
 * @param {string} label - the failure prefix.
 * @returns {void}
 */
function assertGrammar(chunks, label) {
  const open = new Map()
  let usageSeen = false
  let finished = false
  for (const chunk of chunks) {
    assert.equal(finished, false, `${label}: emitted ${chunk.type} after the terminal finish`)
    switch (chunk.type) {
      case 'block-start':
        assert.ok(Number.isSafeInteger(chunk.index) && chunk.index >= 0, `${label}: bad index`)
        assert.equal(open.has(chunk.index), false, `${label}: repeat block-start ${chunk.index}`)
        open.set(chunk.index, chunk.blockType)
        break
      case 'text-delta':
        assert.equal(open.get(chunk.index), 'text', `${label}: text delta without an open text block`)
        break
      case 'reasoning-delta':
        assert.equal(open.get(chunk.index), 'reasoning', `${label}: reasoning delta without an open block`)
        break
      case 'tool-call-delta':
        assert.equal(open.get(chunk.index), 'tool-call', `${label}: tool delta without an open block`)
        break
      case 'block-end':
        assert.equal(open.get(chunk.index), chunk.block.type, `${label}: block-end ${chunk.index} closes the wrong type`)
        open.delete(chunk.index)
        break
      case 'usage':
        assert.equal(usageSeen, false, `${label}: usage emitted twice`)
        usageSeen = true
        break
      case 'finish':
        if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') {
          assert.equal(open.size, 0, `${label}: finished with ${open.size} open block(s)`)
        }
        finished = true
        break
      default:
        assert.fail(`${label}: unknown chunk type ${String(chunk.type)}`)
    }
  }
  assert.equal(finished, true, `${label}: the stream ended without a terminal finish`)
}

test('a response that stays under the cutoff passes through untouched', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hello ' },
    { type: 'text-delta', index: 0, text: 'world' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const seen = await collect(guardStream(emit(chunks), { limit: 1000, estimate, onCut: () => assert.fail('cut a response that had room') }))
  assert.deepEqual(seen, chunks)
  assertGrammar(seen, 'under-limit')
})

test('the cutoff closes every open block before finishing as max-tokens', async () => {
  // Each delta is 35 characters and 10 estimated tokens. A cutoff of 42 lands
  // on the fifth: four deltas are still under it, the fifth crosses it.
  const state = {}
  const seen = await collect(guardStream(textStream(5, state), { limit: 42, estimate, onCut: () => {} }))
  assertGrammar(seen, 'cut')

  // The provider's own block-end and finish are never reached: the guard stops
  // reading at the cut, and the only block-end a consumer sees is the crafted
  // one, which carries everything the block had accumulated.
  assert.deepEqual(seen.at(-2), { type: 'block-end', index: 0, block: { type: 'text', text: 'a'.repeat(175) } })
  assert.deepEqual(seen.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(seen.filter((chunk) => chunk.type === 'text-delta').length, 5)
  assert.equal(seen.filter((chunk) => chunk.type === 'block-end').length, 1)
  assert.equal(state.closed, true, 'the provider stream was not released')
})

test('the cutoff stops reading the provider instead of draining it', async () => {
  let pulled = 0
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }]
  for (let i = 0; i < 500; i += 1) chunks.push({ type: 'text-delta', index: 0, text: 'a'.repeat(35) })
  const counting = (async function* () {
    for (const chunk of chunks) {
      pulled += 1
      yield chunk
    }
  })()
  const seen = await collect(guardStream(counting, { limit: 10, estimate, onCut: () => {} }))
  assert.equal(seen.at(-1).type, 'finish')
  assert.ok(pulled < 10, `read ${pulled} chunks; the guard should stop at the cut`)
})

test('a hand-closed tool call is closed with the shape the assembler would invent', async () => {
  const source = emit([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-9', name: 'read', argumentsDelta: '{"path":"a"}' },
    { type: 'block-start', index: 2, blockType: 'text' },
    { type: 'text-delta', index: 2, text: 'a'.repeat(2000) },
  ])
  const seen = await collect(guardStream(source, { limit: 10, estimate, onCut: () => {} }))
  assertGrammar(seen, 'tool-call cut')
  // Only the blocks still open at the cut are crafted. Index 0 was closed by
  // the provider, so its block-end is passed through rather than synthesized.
  const crafted = seen.slice(seen.findLastIndex((chunk) => chunk.type === 'text-delta') + 1)
  assert.deepEqual(crafted, [
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-9', name: 'read', arguments: '{"path":"a"}' } },
    { type: 'block-end', index: 2, block: { type: 'text', text: 'a'.repeat(2000) } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
})

test('a tool call cut before it named itself still closes, with the assembler default', async () => {
  const source = emit([
    { type: 'block-start', index: 3, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 3, argumentsDelta: '{"a"' },
    { type: 'text-delta', index: 0, text: 'x' },
  ])
  const seen = await collect(guardStream(source, { limit: 1, estimate, onCut: () => {} }))
  assertGrammar(seen, 'anonymous tool call')
  assert.deepEqual(seen.filter((chunk) => chunk.type === 'block-end'), [
    { type: 'block-end', index: 3, block: { type: 'tool-call', id: 'call-3', name: '', arguments: '{"a"' } },
  ])
})

test('a provider that truncates on its own is reported, then passed through', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'a'.repeat(700) },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'a'.repeat(700) } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const cuts = []
  const seen = await collect(
    guardStream(emit(chunks), { limit: 10_000, estimate, onCut: (used, reason) => cuts.push([used, reason]) }),
  )
  assert.deepEqual(seen, chunks)
  assertGrammar(seen, 'provider truncation')
  assert.deepEqual(cuts, [[200, 'truncated']])
})

test('the report fires once and only once, whatever the stream does', async () => {
  const cuts = []
  const onCut = (used, reason) => cuts.push([used, reason])
  await collect(guardStream(textStream(4), { limit: 10_000, estimate, onCut }))
  assert.deepEqual(cuts, [], 'a complete response is not a truncation')
  // Four deltas of ten tokens against a cutoff of 25: the third crosses it.
  await collect(guardStream(textStream(4), { limit: 25, estimate, onCut }))
  assert.deepEqual(cuts, [[30, 'guarded']])
})

test('a report that throws cannot break the response', async () => {
  const seen = await collect(
    guardStream(textStream(4), {
      limit: 10,
      estimate,
      onCut: () => {
        throw new Error('the parent is gone')
      },
    }),
  )
  assertGrammar(seen, 'throwing report')
  assert.deepEqual(seen.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('a provider stream that fails to close does not turn a cut into an error', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'a'.repeat(700) },
  ]
  const seen = await collect(guardStream(emitThenFail(chunks), { limit: 10, estimate, onCut: () => {} }))
  assertGrammar(seen, 'hostile teardown')
  assert.deepEqual(seen.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('a consumer that walks away still releases the provider stream', async () => {
  const state = {}
  const guarded = guardStream(textStream(50, state), { limit: 10_000, estimate, onCut: () => {} })
  const iterator = guarded[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return()
  assert.equal(state.closed, true, 'the provider stream was left running')
})

test('observeChunk and outputTokensOf agree with the deltas a consumer sees', async () => {
  const open = new Map()
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hello' },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'c', name: 'grep', argumentsDelta: '{"pattern":"x"}' },
    // A delta for a block that never opened is billed as output but cannot be
    // closed, because closing it is only possible for a block that was seen.
    { type: 'tool-call-delta', index: 4, argumentsDelta: '{"stray":true}' },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  let total = 0
  for (const chunk of chunks) {
    observeChunk(open, chunk)
    total += outputTokensOf(chunk, estimate)
  }
  assert.equal(open.size, 2)
  assert.equal(open.get(0).text, 'hello')
  assert.equal(open.get(1).toolCallName, 'grep')
  assert.equal(open.get(1).toolCallArguments, '{"pattern":"x"}')
  assert.equal(total, estimate('hello') + estimate('grep') + estimate('{"pattern":"x"}') + estimate('{"stray":true}'))
  observeChunk(open, { type: 'block-end', index: 1, block: { type: 'tool-call' } })
  assert.equal(open.size, 1)
})

test('usage and finish chunks cost no output tokens', () => {
  assert.equal(outputTokensOf({ type: 'usage', usage: { inputTokens: 1, outputTokens: 9, totalTokens: 10 } }, estimate), 0)
  assert.equal(outputTokensOf({ type: 'finish', reason: { kind: 'stop' } }, estimate), 0)
  assert.equal(outputTokensOf({ type: 'block-start', index: 0, blockType: 'text' }, estimate), 0)
})
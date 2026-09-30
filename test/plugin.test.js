/**
 * Tests for the plugin's wiring: one `llm/stream` listener, the ceiling it
 * resolves, and the parent hand-off it performs.
 *
 * The fake context and fake agents mirror the small slice of the Cordis and
 * agent APIs this plugin is allowed to touch, so a change that reaches for
 * something else fails here rather than in a live profile.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../src/plugin.js'

/** A 4000-character text block: about 1143 estimated tokens. */
const LONG = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'a'.repeat(4000) },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'a'.repeat(4000) } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A 35-character text block: 10 estimated tokens, far below any cutoff. */
const SHORT = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'a'.repeat(35) },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'a'.repeat(35) } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/**
 * Build the slice of a Cordis plugin context this plugin uses.
 *
 * @param {object} [services] - the services `get` and `inject` should resolve.
 * @returns {{ctx: object, listeners: object[], lines: unknown[][]}} the context,
 * its registrations, and its log lines.
 */
function fakeContext(services = {}) {
  const listeners = []
  const lines = []
  const record = (level) => (line) => lines.push([level, line])
  return {
    listeners,
    lines,
    ctx: {
      logger: { info: record('info'), warn: record('warn'), error: record('error') },
      on: (event, handler, options) => listeners.push({ event, handler, options }),
      get: (name) => services[name],
      inject: (names, callback) => {
        const scoped = {}
        for (const name of names) scoped[name] = services[name]
        callback(scoped)
      },
    },
  }
}

/**
 * Build the slice of a live agent this plugin reads.
 *
 * @param {object} spec - the agent's identity and ancestry.
 * @param {string} spec.id - its session id.
 * @param {number} [spec.maxTokens] - its own model-output option.
 * @param {object} [spec.header] - its session header.
 * @returns {object} the fake agent, with a `steered` log.
 */
function fakeAgent({ id, maxTokens, header }) {
  const steered = []
  return {
    id,
    steered,
    session: { id, header: header ?? { id } },
    options: maxTokens === undefined ? {} : { maxTokens },
    status: 'running',
    steer: (message) => steered.push(message),
  }
}

/** A registry of agents, keyed by session id, that the plugin can look up. */
function fakeAgents(agents, onLookup) {
  const registry = new Map(agents.map((agent) => [agent.id, agent]))
  return {
    get: (sessionId) => {
      onLookup?.(sessionId)
      return registry.get(sessionId)
    },
  }
}

/** The plugin's single registration. */
function listenerOf(listeners) {
  const matches = listeners.filter((entry) => entry.event === 'llm/stream')
  assert.equal(matches.length, 1)
  return matches[0]
}

/**
 * Drive the registered listener over one fake response.
 *
 * @param {object} registration - the plugin's `llm/stream` registration.
 * @param {object} options - the request the harness would pass.
 * @param {object[]} chunks - the response the adapter would stream.
 * @param {{onChunk?: (chunk: object, seen: object[]) => void}} [observe] - a
 * hook that runs as each chunk is delivered.
 * @returns {Promise<object[]>} the chunks the consumer saw.
 */
async function stream(registration, options, chunks, observe) {
  const source = async function* () {
    for (const chunk of chunks) yield chunk
  }
  const seen = []
  for await (const chunk of registration.handler(options, source)) {
    seen.push(chunk)
    observe?.onChunk?.(chunk, seen)
  }
  return seen
}

test('apply registers exactly one global llm/stream listener and reports readiness', () => {
  const { ctx, listeners, lines } = fakeContext()
  apply(ctx, {})
  const registration = listenerOf(listeners)
  assert.deepEqual(registration.options, { global: true })
  assert.ok(lines.some(([level, line]) => level === 'info' && String(line).startsWith('[dsh-auto-stop] ')))
})

test('a root conversation that runs out of room is cut, and nobody is steered', async () => {
  const root = fakeAgent({ id: 'root-1' })
  const { ctx, listeners } = fakeContext({ agents: fakeAgents([root]) })
  apply(ctx, {})

  const seen = await stream(listenerOf(listeners), { sessionId: 'root-1', maxTokens: 1024 }, LONG)
  assert.deepEqual(seen.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(root.steered.length, 0, 'a root conversation has no parent to tell')
})

test('a child that runs out of room is handed back to its parent, before the finish', async () => {
  const parent = fakeAgent({ id: 'parent-1' })
  const child = fakeAgent({ id: 'child-1', header: { id: 'child-1', origin: 'subagent', parentSession: 'parent-1' } })
  const { ctx, listeners } = fakeContext({ agents: fakeAgents([parent, child]) })
  apply(ctx, {})

  let steeredWhenFinishArrived = -1
  const seen = await stream(listenerOf(listeners), { sessionId: 'child-1', maxTokens: 1024 }, LONG, {
    onChunk: (chunk) => {
      if (chunk.type === 'finish') steeredWhenFinishArrived = parent.steered.length
    },
  })

  assert.deepEqual(seen.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(steeredWhenFinishArrived, 1, 'the parent must already know when the finish is visible')
  assert.equal(parent.steered.length, 1)
  assert.equal(child.steered.length, 0)

  const notice = parent.steered[0]
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'user')
  assert.equal(notice.content[0].type, 'text')
  assert.match(notice.content[0].text, /child-1/)
  assert.match(notice.content[0].text, /send_message\(agent_id="child-1", message="继续/)
  assert.ok(Object.isFrozen(notice), 'a steered message must be frozen, like every other')
})

test('the ceiling comes from the adapter when neither the request nor the agent names one', async () => {
  const parent = fakeAgent({ id: 'parent-1' })
  const child = fakeAgent({ id: 'child-1', header: { id: 'child-1', origin: 'subagent', parentSession: 'parent-1' } })
  const asked = []
  const { ctx, listeners } = fakeContext({
    agents: fakeAgents([parent, child]),
    llm: {
      resolveModelInfo: async (provider, model) => {
        asked.push(`${provider}/${model}`)
        return { defaultMaxTokens: 1024 }
      },
    },
  })
  apply(ctx, {})

  const seen = await stream(listenerOf(listeners), { sessionId: 'child-1', provider: 'openai', model: 'gpt-x' }, LONG)
  assert.deepEqual(seen.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.deepEqual(asked, ['openai/gpt-x'])
  assert.equal(parent.steered.length, 1)

  // The disclosure is cached per model: a second call must not re-ask.
  await stream(listenerOf(listeners), { sessionId: 'child-1', provider: 'openai', model: 'gpt-x' }, LONG)
  assert.deepEqual(asked, ['openai/gpt-x'])
})

test('the owning agent\u2019s own option is the ceiling when the request omits one', async () => {
  const agent = fakeAgent({ id: 'solo', maxTokens: 1024 })
  const { ctx, listeners } = fakeContext({ agents: fakeAgents([agent]) })
  apply(ctx, {})
  const seen = await stream(listenerOf(listeners), { sessionId: 'solo' }, LONG)
  assert.deepEqual(seen.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('an undisclosed ceiling leaves the response alone', async () => {
  const agent = fakeAgent({ id: 'solo' })
  const { ctx, listeners, lines } = fakeContext({
    agents: fakeAgents([agent]),
    llm: { resolveModelInfo: async () => ({}) },
  })
  apply(ctx, {})
  const seen = await stream(listenerOf(listeners), { sessionId: 'solo', provider: 'p', model: 'm' }, LONG)
  assert.deepEqual(seen, LONG)
  assert.equal(lines.filter(([level]) => level === 'warn').length, 0, 'a quiet model is not a warning')
})

test('an undisclosed ceiling still hands a provider-side truncation back', async () => {
  const parent = fakeAgent({ id: 'parent-1' })
  const child = fakeAgent({ id: 'child-1', header: { id: 'child-1', origin: 'subagent', parentSession: 'parent-1' } })
  const { ctx, listeners } = fakeContext({
    agents: fakeAgents([parent, child]),
    llm: { resolveModelInfo: async () => ({}) },
  })
  apply(ctx, {})

  // The adapter truncates where the plugin could not: no ceiling was disclosed,
  // so the pre-emptive half has nothing to fire at, and the child is handed back
  // only because the provider's own cut is still watched for.
  const truncated = [...LONG.slice(0, 3), { type: 'finish', reason: { kind: 'max-tokens' } }]
  const seen = await stream(listenerOf(listeners), { sessionId: 'child-1', provider: 'p', model: 'm' }, truncated)
  assert.deepEqual(seen, truncated, 'the provider\u2019s own stream is passed through untouched')
  assert.equal(parent.steered.length, 1)
  assert.match(parent.steered[0].content[0].text, /child-1/)
})

test('a discovery failure is reported once and never breaks the response', async () => {
  const agent = fakeAgent({ id: 'solo' })
  const { ctx, listeners, lines } = fakeContext({
    agents: fakeAgents([agent]),
    llm: {
      resolveModelInfo: async () => {
        throw new Error('discovery is offline')
      },
    },
  })
  apply(ctx, {})
  const seen = await stream(listenerOf(listeners), { sessionId: 'solo', provider: 'p', model: 'm' }, LONG)
  assert.deepEqual(seen, LONG)
  const warnings = lines.filter(([level]) => level === 'warn')
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][1]), /discovery is offline/)
})

test('a ceiling below the intervention threshold is left alone', async () => {
  const agent = fakeAgent({ id: 'solo' })
  const { ctx, listeners } = fakeContext({ agents: fakeAgents([agent]) })
  apply(ctx, {})
  const seen = await stream(listenerOf(listeners), { sessionId: 'solo', maxTokens: 512 }, LONG)
  assert.deepEqual(seen, LONG, 'a small ceiling is not worth cutting in half')
})

test('a call with a purpose is never touched', async () => {
  const parent = fakeAgent({ id: 'parent-1' })
  const child = fakeAgent({ id: 'child-1', header: { id: 'child-1', origin: 'subagent', parentSession: 'parent-1' } })
  const { ctx, listeners } = fakeContext({ agents: fakeAgents([parent, child]) })
  apply(ctx, {})
  const seen = await stream(listenerOf(listeners), { sessionId: 'child-1', maxTokens: 1024, purpose: 'compaction' }, LONG)
  assert.deepEqual(seen, LONG)
  assert.equal(parent.steered.length, 0, 'compaction output is the harness\u2019s business, not this plugin\u2019s')
})

test('disabled means disarmed: every config field is re-read per call', async () => {
  const agent = fakeAgent({ id: 'solo' })
  const { ctx, listeners } = fakeContext({ agents: fakeAgents([agent]) })
  let armed = true
  // A volatile field is a stable reference whose contents change, so the plugin
  // must resolve it per call or a saved setting would never take effect.
  apply(ctx, { enabled: { get: () => armed } })

  const registration = listenerOf(listeners)
  assert.deepEqual((await stream(registration, { sessionId: 'solo', maxTokens: 1024 }, LONG)).at(-1), {
    type: 'finish',
    reason: { kind: 'max-tokens' },
  })
  armed = false
  assert.deepEqual(await stream(registration, { sessionId: 'solo', maxTokens: 1024 }, LONG), LONG)
})

test('notifyParent false keeps the cut and drops the hand-off', async () => {
  const parent = fakeAgent({ id: 'parent-1' })
  const child = fakeAgent({ id: 'child-1', header: { id: 'child-1', origin: 'subagent', parentSession: 'parent-1' } })
  const { ctx, listeners } = fakeContext({ agents: fakeAgents([parent, child]) })
  apply(ctx, { notifyParent: false })
  const seen = await stream(listenerOf(listeners), { sessionId: 'child-1', maxTokens: 1024 }, LONG)
  assert.deepEqual(seen.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(parent.steered.length, 0)
})

test('a fork is not a child, so its parentSession is not steered', async () => {
  const origin = fakeAgent({ id: 'origin-1' })
  const fork = fakeAgent({ id: 'fork-1', header: { id: 'fork-1', parentSession: 'origin-1' } })
  const { ctx, listeners } = fakeContext({ agents: fakeAgents([origin, fork]) })
  apply(ctx, {})
  const seen = await stream(listenerOf(listeners), { sessionId: 'fork-1', maxTokens: 1024 }, LONG)
  assert.deepEqual(seen.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(origin.steered.length, 0, 'a fork is an independent conversation')
})

test('a child whose parent is gone is reported, not thrown at', async () => {
  const child = fakeAgent({ id: 'child-1', header: { id: 'child-1', origin: 'subagent', parentSession: 'parent-1' } })
  const { ctx, listeners, lines } = fakeContext({ agents: fakeAgents([child]) })
  apply(ctx, {})
  const seen = await stream(listenerOf(listeners), { sessionId: 'child-1', maxTokens: 1024 }, LONG)
  assert.deepEqual(seen.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.match(String(lines.find(([level]) => level === 'warn')[1]), /parent-1 is not live/)
})

test('an agent registry that throws is not fatal', async () => {
  const { ctx, listeners, lines } = fakeContext({
    agents: {
      get: () => {
        throw new Error('registry is closed')
      },
    },
  })
  apply(ctx, {})
  const seen = await stream(listenerOf(listeners), { sessionId: 'solo', maxTokens: 32768 }, SHORT)
  assert.deepEqual(seen, SHORT)
  assert.equal(lines.filter(([level]) => level === 'error').length, 0)
})

test('a missing llm service leaves the response alone instead of failing to load', async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, {})
  const seen = await stream(listenerOf(listeners), { sessionId: 'solo', provider: 'p', model: 'm' }, SHORT)
  assert.deepEqual(seen, SHORT)
})

test('a response that fits is delivered chunk for chunk, usage included', async () => {
  const agent = fakeAgent({ id: 'solo', maxTokens: 32768 })
  const { ctx, listeners } = fakeContext({ agents: fakeAgents([agent]) })
  apply(ctx, {})
  const chunks = [...SHORT.slice(0, -1), { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }, SHORT.at(-1)]
  const seen = await stream(listenerOf(listeners), { sessionId: 'solo' }, chunks)
  assert.deepEqual(seen, chunks)
})
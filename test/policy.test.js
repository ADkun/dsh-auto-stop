/**
 * Tests for the decision layer: how much room a call has, where the cutoff
 * lands, and what the hand-off says.
 *
 * Nothing here touches Cordis or a model, so every case is exact.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { readPositiveInteger, resolveCutoff } from '../src/budget.js'
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js'
import { estimateText } from '../src/estimate.js'
import { isDelegatedChild, parentSessionIdOf } from '../src/lineage.js'
import { createNotice, renderTemplate, truncationNotice } from '../src/notify.js'
import { SCHEMA_SPECIFIER, readConfig, readField } from '../src/settings.js'

/** A config with defaults, for tests that only care about one field. */
const base = () => normalizeConfig({})

test('estimateText: an ASCII body counts against charsPerToken', () => {
  assert.equal(estimateText('a'.repeat(35), base()), 10)
})

test('estimateText: CJK characters count per character, not per four', () => {
  // The harness's own flat 4-chars-per-token rule would say 2.5 here.
  assert.equal(estimateText('中'.repeat(10), base()), 8)
})

test('estimateText: a mixed body pays the right rate on each half', () => {
  assert.equal(estimateText(`${'a'.repeat(7)}${'中'.repeat(5)}`, base()), 7 / 3.5 + 4)
})

test('estimateText: a larger divisor makes the estimate smaller, never negative', () => {
  const configuration = normalizeConfig({ charsPerToken: 16 })
  assert.equal(estimateText('a'.repeat(32), configuration), 2)
  assert.equal(estimateText('', configuration), 0)
  assert.equal(estimateText(undefined, configuration), 0)
  assert.equal(estimateText(42, configuration), 0)
})

test('estimateText: full-width punctuation is charged as a wide character', () => {
  assert.equal(estimateText('，。！？', base()), 4 * 0.8)
})

test('readPositiveInteger: only a usable ceiling gets through', () => {
  assert.equal(readPositiveInteger(32768), 32768)
  assert.equal(readPositiveInteger(1), 1)
  for (const bad of [0, -1, 1.5, NaN, Infinity, '32000', null, undefined, {}]) {
    assert.equal(readPositiveInteger(bad), undefined, `${String(bad)} is not a ceiling`)
  }
})

test('resolveCutoff: the reserve is a ratio with a floor', () => {
  // 5% of 32768 is 1638, far above the 256 floor.
  assert.equal(resolveCutoff(32768, base()), 32768 - 1638)
  // 5% of 4096 is 205, so the floor wins.
  assert.equal(resolveCutoff(4096, base()), 4096 - 256)
})

test('resolveCutoff: a ceiling too small to hold a reserve is left alone', () => {
  assert.equal(resolveCutoff(512, base()), undefined)
  assert.equal(resolveCutoff(1023, base()), undefined)
  assert.equal(resolveCutoff(1024, base()), 1024 - 256)
})

test('resolveCutoff: a floor larger than the ceiling refuses to guess', () => {
  assert.equal(resolveCutoff(100, normalizeConfig({ reserveRatio: 0.5, reserveMin: 256, minBudget: 1 })), undefined)
})

test('resolveCutoff: no disclosed ceiling means no cutoff', () => {
  assert.equal(resolveCutoff(undefined, base()), undefined)
  assert.equal(resolveCutoff(null, base()), undefined)
})

test('normalizeConfig: an absent block resolves to every default', () => {
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig({}), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig('nonsense'), { ...DEFAULT_CONFIG })
})

test('normalizeConfig: a wrong type falls back instead of propagating', () => {
  const configuration = normalizeConfig({
    enabled: 'yes',
    reserveMin: 'big',
    notifyParent: 1,
    parentPrompt: '   ',
    continueMessage: null,
  })
  assert.equal(configuration.enabled, true)
  assert.equal(configuration.reserveMin, DEFAULT_CONFIG.reserveMin)
  assert.equal(configuration.notifyParent, true)
  assert.equal(configuration.parentPrompt, DEFAULT_CONFIG.parentPrompt)
  assert.equal(configuration.continueMessage, DEFAULT_CONFIG.continueMessage)
})

test('normalizeConfig: numbers are clamped into their usable range', () => {
  const wild = normalizeConfig({ reserveRatio: 4, charsPerToken: -3, cjkTokensPerChar: 99, reserveMin: -5 })
  assert.equal(wild.reserveRatio, 0.5)
  assert.equal(wild.charsPerToken, 0.5)
  assert.equal(wild.cjkTokensPerChar, 4)
  assert.equal(wild.reserveMin, 0)
  // A reserve of 0 would cut exactly at the ceiling, which is the failure mode
  // this plugin exists to avoid; the floor keeps a real response possible.
  assert.equal(resolveCutoff(32768, wild), 32768 - 16384)
})

test('readField: a volatile field is read through .get(), anything else passes', () => {
  assert.equal(readField({ get: () => 7 }), 7)
  assert.equal(readField(7), 7)
  assert.equal(readField(undefined), undefined)
})

test('readConfig: every field is resolved into plain values', () => {
  assert.deepEqual(readConfig({ a: { get: () => 1 }, b: 2 }), { a: 1, b: 2 })
  assert.deepEqual(readConfig(null), {})
  assert.deepEqual(readConfig([1, 2]), {})
  assert.equal(SCHEMA_SPECIFIER, '@deepseek-ai/schemastery')
})

test('lineage: only a delegation with both fields is a child', () => {
  assert.equal(isDelegatedChild(undefined), false)
  assert.equal(isDelegatedChild({}), false)
  // A root conversation.
  assert.equal(isDelegatedChild({ id: 's1', origin: undefined, parentSession: undefined }), false)
  // A fork shares its parentSession but is an independent conversation.
  assert.equal(isDelegatedChild({ id: 's2', parentSession: 'root' }), false)
  // A delegated child.
  assert.equal(isDelegatedChild({ id: 's3', origin: 'subagent', parentSession: 'root' }), true)
  // A delegated child always has a parent, so this pair cannot be separated.
  assert.equal(isDelegatedChild({ origin: 'subagent' }), false)
})

test('lineage: the parent id survives branding and is absent otherwise', () => {
  assert.equal(parentSessionIdOf({ origin: 'subagent', parentSession: 'root' }), 'root')
  assert.equal(parentSessionIdOf({ parentSession: 'root' }), undefined)
  assert.equal(parentSessionIdOf({}), undefined)
})

test('createNotice: a message the harness can deliver, frozen throughout', () => {
  const notice = createNotice('hello')
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'user')
  assert.deepEqual(notice.content, [{ type: 'text', text: 'hello' }])
  assert.match(notice.id, /^[0-9a-f-]{36}$/)
  assert.equal(typeof notice.id, 'string')
  assert.ok(Object.isFrozen(notice))
  assert.ok(Object.isFrozen(notice.content))
  assert.ok(Object.isFrozen(notice.content[0]))
  assert.ok(Object.isFrozen(notice.source))
  assert.notEqual(createNotice('hello').id, notice.id)
})

test('renderTemplate: known placeholders are filled, unknown ones are kept', () => {
  assert.equal(renderTemplate('a {x} b {y}', { x: 1, y: 2 }), 'a 1 b 2')
  assert.equal(renderTemplate('a {typo}', { x: 1 }), 'a {typo}')
  assert.equal(renderTemplate('a {x} b {x}', { x: 'z' }), 'a z b z')
  assert.equal(renderTemplate(undefined, {}), 'undefined')
})

test('truncationNotice: names the child and the exact call that continues it', () => {
  const text = truncationNotice(base(), 'child-1', 31000.4)
  assert.match(text, /child-1/)
  assert.match(text, /send_message\(agent_id="child-1", message="继续/)
  assert.match(text, /31000/)
  assert.doesNotMatch(text, /\{agentId\}|\{tokens\}|\{continueMessage\}/)
})

test('truncationNotice: an operator can retarget both halves', () => {
  const configuration = normalizeConfig({ parentPrompt: 'child {agentId} died at {tokens}', continueMessage: 'keep going' })
  assert.equal(truncationNotice(configuration, 'c9', 5), 'child c9 died at 5')
})
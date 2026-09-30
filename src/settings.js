/**
 * The live configuration schema behind the Plugins page form.
 *
 * DSH derives one config form per active profile entry from that entry's own
 * `Config`, and only fields declared `.volatile()` may be edited while the
 * plugin runs. `Config` therefore has to be part of the plugin object the Loader
 * resolves — the default export of `src/plugin.js` — and it is built once here,
 * at module evaluation.
 *
 * Schemastery is resolved at runtime rather than imported statically: it ships
 * with the harness, but a checkout of this repository has no `node_modules` at
 * all. A deployment that cannot resolve it loses the form and keeps every other
 * behaviour; the plugin never fails to load over a UI it may not be able to
 * show.
 *
 * Every field here is volatile on purpose. `apply` re-reads the resolved config
 * before each model call, so a value saved in the Plugins page takes effect on
 * the very next response without remounting the row.
 *
 * @module dsh-auto-stop/settings
 */

import { createRequire } from 'node:module'

import { DEFAULT_CONFIG } from './config.js'

const localRequire = createRequire(import.meta.url)

/** The specifier the harness's own schema library resolves to. */
export const SCHEMA_SPECIFIER = '@deepseek-ai/schemastery'

/** Hint the form shows beside each option, keyed by option name. */
const DESCRIPTIONS = Object.freeze({
  enabled: '总开关；关掉后本插件不再介入任何模型输出',
  reserveRatio: '预留比例：在输出上限之前留出这么多（0.05 = 5%），提前收尾',
  reserveMin: '预留的 token 下限；上限很小的模型用它兜底',
  charsPerToken: '非中文文本每 token 约几个字符；调小 = 更早收尾（更保守）',
  cjkTokensPerChar: '中文/日文/韩文每个字约几个 token',
  minBudget: '输出上限低于该值时完全不介入',
  notifyParent: '子代理触顶时，通知它的父代理立刻让它继续写',
  parentPrompt: '发给父代理的通知；可用 {agentId} {continueMessage} {tokens}',
  continueMessage: '父代理应原样发回给子代理的内容',
})

/**
 * Resolve the harness's schema library.
 *
 * @returns {object | undefined} the schemastery namespace, or `undefined` when
 * the running environment has no copy of it.
 */
export function loadSchema() {
  try {
    const loaded = localRequire(SCHEMA_SPECIFIER)
    const schema = loaded?.default ?? loaded
    return typeof schema?.object === 'function' ? schema : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the row's `Config` schema.
 *
 * Defaults mirror {@link DEFAULT_CONFIG}, so a row whose `config:` block omits a
 * key resolves to the plugin's own default rather than to a schema-only value.
 *
 * @param {object | undefined} Schema - schemastery, when it resolved.
 * @returns {object | undefined} the schema, or `undefined` without schemastery.
 */
export function buildConfigSchema(Schema) {
  if (Schema === undefined) return undefined
  /** One field: a default plus the `.volatile()` marker the form reads. */
  const field = (node, key) => node.default(DEFAULT_CONFIG[key]).volatile().description(DESCRIPTIONS[key])
  return Schema.object({
    enabled: field(Schema.boolean(), 'enabled'),
    reserveRatio: field(Schema.number(), 'reserveRatio'),
    reserveMin: field(Schema.number(), 'reserveMin'),
    charsPerToken: field(Schema.number(), 'charsPerToken'),
    cjkTokensPerChar: field(Schema.number(), 'cjkTokensPerChar'),
    minBudget: field(Schema.number(), 'minBudget'),
    notifyParent: field(Schema.boolean(), 'notifyParent'),
    parentPrompt: field(Schema.string(), 'parentPrompt'),
    continueMessage: field(Schema.string(), 'continueMessage'),
  })
}

/** The row's schema, or `undefined` in an environment without schemastery. */
export const Config = buildConfigSchema(loadSchema())

/**
 * Read one resolved field of a row's Config.
 *
 * A volatile field arrives as the stable reference the Loader rewrites when a
 * saved value is applied, so `.get()` is where a live value comes from; any
 * other field is plain data and passes through untouched.
 *
 * @param {unknown} value - one field of the resolved config.
 * @returns {unknown} the current plain value.
 */
export function readField(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

/**
 * Resolve every field of a row's Config into plain values.
 *
 * Called before each model call rather than once at activation, so live edits
 * are picked up: the field references are stable, their contents are not.
 *
 * @param {unknown} config - the resolved config the Loader handed to `apply`.
 * @returns {Record<string, unknown>} plain values, ready for `normalizeConfig`.
 */
export function readConfig(config) {
  const plain = {}
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return plain
  for (const [key, value] of Object.entries(config)) plain[key] = readField(value)
  return plain
}
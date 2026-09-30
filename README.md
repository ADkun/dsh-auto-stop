# dsh-auto-stop

A DSH plugin that ends a response **just before** it reaches the model's output
ceiling, so the truncation notice appears while there is still room to close the
answer cleanly — and when the response belonged to a **subagent**, tells that
subagent's parent agent to send it straight back to work.

```
已达到输出 token 上限
回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。
```

DSH already stops at the ceiling, and stops *at* it: the turn ends mid-sentence,
tool calls are dropped, and getting the rest of the answer depends on someone
noticing and asking. For a background subagent nobody notices at all — it cannot
ask for its own continuation, and the parent only learns about it if it happens
to read the settlement notice.

This plugin moves the stop a little earlier and makes the follow-up automatic.

## How it works

**1. A pre-emptive cutoff on the model's output stream.** It registers one
`llm/stream` listener — the waterfall that wraps every streaming model call — and
resolves the output ceiling of the call being made, in the harness's own order of
authority:

| source | meaning |
| --- | --- |
| `options.maxTokens` | the frozen per-request cap on this call |
| `agent.options.maxTokens` | what the loop asked its agent for |
| `llm.resolveModelInfo(...).defaultMaxTokens` | the cap the adapter materializes when a caller omits one |

It meters the response as it arrives (CJK-aware; see *Limitations*), and once the
estimate reaches `ceiling - reserve` it closes the blocks still open, emits the
harness's own terminal `{ kind: 'max-tokens' }`, and stops reading the provider.

That terminal chunk is not a hack around DSH; it *is* DSH's truncation path. A
`max-tokens` finish makes the agent loop commit the partial assistant message,
latch the reason, skip tool dispatch (under `max-tokens`, the block assembler
drops tool-call blocks precisely because they cannot be executed safely), end the
turn, and render the notice above. Everything downstream — the durable session
log, the chat message, `SubagentResult.stopReason` — follows from the same
signal, so nothing downstream needs to know this plugin exists.

**2. A parent hand-off for truncated children.** When the agent that ran out of
room is a delegated child, the plugin steers one two-line notice into its *parent*
agent, naming the exact call that continues it:

```
[dsh-auto-stop] 子代理 <child-id> 输出触顶被中断（约 31000 tokens）。
立即发送：send_message(agent_id="<child-id>", message="继续（从断点接着写，不要重复已写内容）")
```

`Agent.steer` is the primitive underneath every DSH delivery path: it splices a
model-facing message into the agent's inbox and wakes it, so an idle parent
starts a turn and reads the notice as an instruction. Its own `send_message` back
to the child then either steers the live child or **cold-resumes the settled
one** — so the hand-off works whether or not the child's run has already ended.

Root conversations are deliberately *not* notified: their audience is you, and
you already get DSH's own notice. A `subagent_fork` is not notified either — it
shares lineage without being a delegation, and steering its "parent" would
interrupt an unrelated conversation.

**3. The hand-off does not depend on the estimate.** If the ceiling was never
disclosed, or the estimate ran low, the provider truncates on its own — and this
plugin reports *that* through the same path. Detecting both kinds of cut is what
keeps a child's continuation automatic in every case.

## Install

```powershell
# from the DSH harness, with this checkout on disk:
plugin_manager install_bundle --target D:\dsh\dsh-auto-stop
```

The bundle's `cordis.patch.yml` inserts one row:

```yaml
- insert:
    - id: dsh-auto-stop
      name: 'dsh-auto-stop'
```

No configuration is required. To remove it, drop the row (or disable it in the
Plugins page).

## Configuration

Every field is editable live from the Plugins page; the plugin re-reads its
resolved config before each model call, so a saved value applies to the very next
response.

| option | default | what it does |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `reserveRatio` | `0.05` | fraction of the ceiling to leave unused |
| `reserveMin` | `256` | floor for that reserve, for small ceilings |
| `charsPerToken` | `3.5` | characters per token outside the CJK ranges |
| `cjkTokensPerChar` | `0.8` | tokens per CJK character |
| `minBudget` | `1024` | ceilings below this are not touched at all |
| `notifyParent` | `true` | hand a truncated child back to its parent |
| `parentPrompt` | *(Chinese, two lines)* | the notice; `{agentId}`, `{tokens}`, `{continueMessage}` |
| `continueMessage` | `继续（从断点接着写，不要重复已写内容）` | what the parent is told to send back |

The cutoff lands at `ceiling - max(reserveMin, ceiling * reserveRatio)`. The
reserve pays for the estimator's error, for the block-closing chunks, and for
whatever the provider counts that no delta ever carried. Ending a response a few
hundred tokens early is harmless; overshooting the real ceiling is the failure
this plugin exists to prevent — hence `3.5` rather than DSH's own flat `4`
characters per token.

## Limitations

- **The estimate is a heuristic.** A stream reports text as it arrives and tokens
  only at the end, so a cutoff that must fire *before* the ceiling cannot wait
  for the provider's own count. The reserve absorbs the error; the provider-side
  detection covers whatever it misses.
- **CJK is estimated per character** (~1 token each) rather than by DSH's flat
  4-chars-per-token rule, which over-counts CJK output fourfold. Widen or narrow
  `cjkTokensPerChar` and `charsPerToken` if your models disagree.
- **A model whose ceiling is never disclosed is not guarded pre-emptively** — it
  is only detected, and only its parent hand-off fires. All built-in adapters
  disclose `defaultMaxTokens`; `resolveModelInfo` is asked once per model and
  cached.
- **Compaction and title calls are skipped.** Those carry a `purpose`, and
  truncating them would corrupt harness-owned output rather than a response.
- **File policy.** The plugin uses `node:crypto` and `node:module`; it never
  imports harness packages at runtime, because they are not resolvable from an
  installed profile.

## Layout

```
src/plugin.js     the listener, the ceiling resolution, the hand-off
src/cutoff.js     stream metering and the synthetic max-tokens finish
src/budget.js     ceiling -> cutoff
src/estimate.js   CJK-aware output-token estimation
src/lineage.js    child vs. root vs. fork
src/notify.js     the steered message and its template
src/config.js     defaults and normalization
src/settings.js   the live Plugins-page schema
test/             node:test, no dependencies
```

## Development

```powershell
npm test        # node --test test
```

The tests need no `node_modules`: the stream tests carry a local copy of DSH's
stream invariant (`@deepseek-ai/dsh-llm/lib/invariant.js`, `validateStream`) so
that a synthetic stream is checked against the real grammar before it is ever
handed to a live harness.

## License

MIT
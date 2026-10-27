# M6 Research and messaging: tickets

`M02-T4` is the Prospect API in core. `M05-T1` creates the outbound repository; `M05-T4` and `M05-T5` give web search and Signals.

### T1: Contract for briefs, drafts, citations and voice
Repo: contract
Blocked by: none

## What to build
The `outbound` research, draft, voice and preview schemas and error codes, plus the playbook `citation` resolve request and response (with a `removed` state). Events `draft.created` and `draft.approved_required`. Tagged.

## Acceptance criteria
- [ ] A citation schema cannot carry a customer deal identifier, name or amount (parse test).
- [ ] Preview request refuses more than five Prospects.
- [ ] Error codes `area.reason`; unknown fields dropped; version bumped, `dist/` rebuilt, tag cut.

### T2: Resolve citations in the Playbook
Repo: playbook
Blocked by: T1

## What to build
A route that resolves a bounded list of Moment and Document references to their current snippets for the token's Organization, returning `removed` for anything deleted or not yet searchable.

## Acceptance criteria
- [ ] Resolves a Moment and a Document passage with the same snippet limits as search.
- [ ] A deleted Document returns `removed`, not its text.
- [ ] A reference from another Organization returns `removed` (second-Organization test).
- [ ] More than the maximum list size is refused; snippets are not logged.

### T3: Schema for voice, briefs, drafts and usage
Repo: db
Blocked by: T1

## What to build
Migration adding `brand_voices` (versioned), `briefs`, `brief_statements`, `drafts`, `draft_citations`, `draft_checks`, `model_usage` to the `outbound` schema.

## Acceptance criteria
- [ ] Every table has `organization_id` under fail-closed row-level security; isolation test updated.
- [ ] A second Organization reads zero rows.
- [ ] Citation rows store ids and scores but not snippet text.
- [ ] Tag cut.

### T4: Brand voice
Repo: outbound
Blocked by: T3, M05-T1

## What to build
Routes to read and save the Organization's brand voice (tone, words to use, banned phrases, sign-off, length limit, default language) as new versions; Owner and Admin only to write.

## Acceptance criteria
- [ ] Saving creates a new version; the previous one is retained and readable.
- [ ] Invalid voice (empty, oversized) returns `voice.invalid`.
- [ ] A Rep can read but not write.
- [ ] Second-Organization test passes.

### T5: Research Brief with grounding
Repo: outbound
Blocked by: T3, M05-T4, M05-T6, M02-T4

## What to build
The `Model` and `WebSearch` ports with memory adapters; `POST` a brief for a Prospect that gathers Prospect fields, Signals, a bounded web search and Playbook search, and returns statements each tied to a supplied source; statements without a valid source are dropped; briefs are cached by Prospect version.

## Acceptance criteria
- [ ] A scripted model inventing a source id has that statement dropped.
- [ ] Web search obeys its deadline; timeout returns `research.timeout` with partial sources marked.
- [ ] Injected instructions in a Signal, field or web page change nothing (test).
- [ ] No Prospect field or brief text in logs (test).
- [ ] Second-Organization test passes.

### T6: Anthropic and Exa adapters
Repo: outbound
Blocked by: T5

## What to build
The first real `Model` adapter (Anthropic) and `WebSearch` adapter (Exa) with timeouts, bounded jittered retry, token caps, a per-Organization monthly spend limit and `model_usage` recording; no-training setting asserted at construction.

## Acceptance criteria
- [ ] Fixture contract tests pass with no network in `verify`; opt-in live test with keys.
- [ ] Exceeding the monthly limit returns `draft.budget_exceeded` before the call.
- [ ] Keys never appear in logs or reports (test).

### T7: Grounded draft with checks
Repo: outbound
Blocked by: T4, T5

## What to build
`POST` a draft for a Prospect, goal and channel (email): Playbook Moment and Document search, writing in the brand voice, citations with evidence counts, the `ungrounded` flag, and checks (citation resolves, unsupported claim, banned phrase, name match, length). Regenerate with an angle or tone.

## Acceptance criteria
- [ ] Citations equal the items the Playbook returned; evidence counts match its response.
- [ ] A draft with no won-Deal citation is `ungrounded` and fails automatic-send eligibility.
- [ ] Each failing check is named on the draft; the voice version used is recorded.
- [ ] Regenerate is idempotent with the same key.
- [ ] A Moment from another Organization can never be cited (second-Organization test).

### T8: Preview on sample Prospects
Repo: outbound
Blocked by: T7

## What to build
`POST` a preview of a campaign setup (goal, voice, language) for up to five sample Prospects returning brief, draft, citations and checks, with no send, no Prospect change and no consent or suppression effect.

## Acceptance criteria
- [ ] Six Prospects is refused with `preview.too_many_prospects`.
- [ ] After a preview, Prospect data, consent and queue are unchanged (test).
- [ ] Preview results are readable only by the requester's Organization.

### T9: Voice and preview screens
Repo: portal
Blocked by: T2, T4, T8

## What to build
Brand voice editor, preview screen (pick sample Prospects, brief, draft, check list, citation drawer showing the resolved Moment or Document and evidence counts, regenerate) and `removed` source state.

## Acceptance criteria
- [ ] Citation drawer opens the resolved passage; a removed source says so.
- [ ] An ungrounded draft is labelled in words, not colour alone.
- [ ] Driven end to end with `agent-browser`; keyboard operable.
- [ ] Rep sees read-only voice; Owner and Admin edit.

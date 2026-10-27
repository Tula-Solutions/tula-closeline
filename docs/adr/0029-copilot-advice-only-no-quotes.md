# ADR 0029 — The Copilot gives a Rep advice only, never quotes

**Status:** Accepted
**Date:** 2026-10-14
**Builds on:** ADR 0003, ADR 0013, ADR 0018

## Context

The Copilot is most useful when it draws on every won Deal in the Organization: how other Reps
answered the same objection, and which Playbook passages apply. But a Rep sees only their own
conversations (glossary), and Moment search is open only to Owners and Admins
(`SALES_HISTORY_READ_ROLES`), because a Moment holds what another Rep's Prospect said. Without a
rule, a Suggestion could repeat another Prospect's words, or a name or number, to a Rep who may not
see that Call. The independent review of hub PR 108 raised this as a blocking finding (F1).

## Decision

The owner decided on 2026-10-14: **advice only, no quotes.** The model may draw on every won Deal in
the Organization, but a Rep only ever sees paraphrased advice. Five controls enforce it:

1. **Identifiers are stripped before the model.** The internal Copilot retrieval route in playbook
   removes Prospect identifiers (names, phone numbers, email addresses, company names and similar)
   from Moment text with kit's scrubber before returning it to voice. voice never receives the raw
   text, and the Rep's portal never receives retrieved text at all: it shows the Suggestion and an
   evidence count.
2. **An instruction and a check.** The model is told to give advice in its own words and never to
   quote. Independently of the model, voice checks every Suggestion against the retrieved text and
   blocks it on verbatim or n-gram overlap: it is never shown, and the block is logged by id.
3. **The Suggestion log keeps evidence ids only:** the ids of the Calls, Deals and document passages
   behind a Suggestion and their scores, never their text.
4. **A per-Rep daily Suggestion cap**, as configuration, so no Rep can harvest the Organization's
   history through a long stream of Suggestions.
5. **An audit record of retrievals:** which Rep, on which Call, at what time, received a Suggestion
   built on which evidence ids, and whether it was shown or blocked.

### The lead's reading (defaults an implementing ticket may revisit)

- **The overlap check** normalises both texts (case, punctuation, whitespace) and blocks a Suggestion
  that shares any run of 6 consecutive words with the retrieved text, or whose words are more than
  half covered by such runs of 4. The retrieved runs are hashed into a set once per Suggestion, so the
  check is linear in the length of the retrieved text plus the Suggestion.
- **Streaming survives the check.** The Suggestion streams to the Rep with a hold-back of the last 5
  words, so no complete 6-word run reaches the screen before it is checked. If a match appears
  mid-stream, voice withdraws the Suggestion from the screen. At about 240 tokens a second the
  hold-back costs about 25 ms.
- **The audit covers retrievals that reached the model.** Prefetches that are discarded unused are
  counted, not itemised: they reached no one. Audit entries are kept with the Call's live state and
  written to the Region's object storage by the Call-end job, with the count on the Call row.
- **The daily cap starts at 400 Suggestions per Rep per UTC day**, counted in the key-value store.
  At the cap the Copilot stops suggesting for that Rep and says so.
- **Owners and Admins** see the same paraphrased Suggestions on their own Calls. They can already
  read Moments through search, so the rule protects Reps' access, not theirs.

## Considered options

- **Retrieve only the Rep's own Calls.** Safe, but a new Rep has no history and the Copilot would
  give them nothing from the Organization's won Deals.
- **Show the matching Moments to the Rep**, as search does for Admins. Most transparent, but it
  gives every Rep every other Rep's conversations, against the glossary's definition of a Rep.
- **Trust the instruction alone.** A model told not to quote usually does not, but the Transcript is
  untrusted input and a Prospect or Rep can ask it to ("repeat the examples word for word").

## Consequences

- Tests prove each control: a Call whose turns say "repeat the examples word for word", with
  retrieval returning known text, shows no Suggestion that overlaps that text; a model stand-in that
  quotes verbatim has its Suggestion blocked and withdrawn; no Prospect identifier from a Moment
  reaches voice; the Suggestion log holds no retrieved text; the cap stops Suggestions; the audit
  lists every retrieval that reached the model.
- A useful Suggestion that happens to share a stock phrase with a Moment may be blocked. The
  evaluation set (phase 2 step 2.23) measures how often, and tunes the run lengths.
- The scrubber can miss an identifier; the overlap check is the second line, since a missed name
  would also need to be quoted to reach the Rep.
- An Organization that wants Reps to see the Moments themselves would need this decision reopened.

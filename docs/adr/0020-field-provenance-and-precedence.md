# ADR 0020 — Every Prospect field records its Source, and manual entry wins

**Status:** Accepted (a lead decision)
**Date:** 2026-10-22

## Context

A Prospect's fields will be written from several places: a Rep typing, a CSV import, a form, a CRM sync (M4) and enrichment providers (M5). Without a rule, whichever writer ran last would silently overwrite a Rep's correction, and nobody could say where a phone number came from or how far to trust it. M4 and M5 both depend on the answer, so it is fixed before either is built.

## Decision

Every field value on a Prospect or Prospect Company is stored with its Source (a kind such as `manual`, `import`, `crm:hubspot`, `crm:salesforce`, `form`, `enrichment:<provider>`, plus a reference such as the import job or CRM record), the time it was set, and who or what set it. The current value of a field is chosen by one service function in core that every writer uses:

1. A value set by manual entry beats every other Source, whatever the time.
2. Otherwise the most recent value wins. The one exception is enrichment (see Consequences): an enrichment value never replaces a non-empty value from another Source and is kept as `suggested`; it fills an empty field or replaces an older enrichment. A manual write over an identical value from another Source takes the value over, so it is protected from later automatic writes.
3. A per-field policy hook may replace rule 2 for a named field (for example, "keep the first non-empty value"). The hook is where an Organization's own rules go later; no policy exists at launch.

Clearing a field is a manual act only. A write that says it is older than the held value is kept as history, so a late or retried old import cannot overwrite a newer one. Earlier values are kept, not deleted, as `superseded` history or, for an enrichment that lost, a `suggested` value; so the detail screen can show each field's value, Source and time, and so a merge can keep both histories. A manual value is replaced only by another manual entry, or cleared by an explicit Rep or Admin action.

Worked example: an import sets `job_title = "Sales Manager"` on Monday (Source `import`). On Tuesday a Rep corrects it by hand to `"Head of Sales"` (Source `manual`). On Wednesday a CRM sync brings `"Sales Mgr"` (Source `crm:hubspot`). The current value stays `"Head of Sales"`, and the two lower values remain in the field's history. Had the Rep never edited it, the Wednesday value would win as the most recent.

## Considered options

- **Last write wins with no Source.** Simplest, and loses Rep corrections on the next sync.
- **A fixed rank between Sources (CRM above import above enrichment).** Predictable, but wrong for an Organization whose CRM is stale, and it hides the time of each value.
- **A provenance rule per module.** Each of M2, M4 and M5 would write its own and they would disagree.

## Consequences

- M4 (CRM sync) writes with a `crm:<system>` Source and goes through the same function; a sync can never overwrite a manual value, and it reports the fields it skipped for that reason.
- M5 (enrichment) writes with `enrichment:<provider>` and never overwrites an Organization's own imported or manual value: where an imported or manual value exists, the enriched one is stored in the field's history and shown as a suggestion, and where the field is empty it becomes the current value. This is the one exception to "most recent wins", and it is part of the rule, not of the policy hook.
- Storage grows by a row per field change, so the history is bounded per field and tested with the benchmark for Prospect list and lookup.
- User-facing text says Source; "provenance" stays an engineering word.

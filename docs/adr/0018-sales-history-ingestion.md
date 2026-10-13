# ADR 0018 — Sales history ingestion: Calls, Deal Outcomes and Moments

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0003, ADR 0007, ADR 0010, ADR 0016, ADR 0017

## Context

Step 1.14 of the phase 1 plan (hub issue 15) loads an Organization's past Calls and Deal Outcomes into its Playbook, so search (step 1.15) can return similar Moments from won Deals. ADR 0016 fixed how documents are uploaded, deleted and purged. ADR 0010 chose AssemblyAI for batch transcription; a second look is in `docs/research/2026-10-13-speech-to-text-vendors.md`. Twelve choices belong to the product owner; the refinements after them are the lead's reading, marked as such. Glossary terms are capitalised here, except "document", which stays lowercase as in ADR 0016.

## Decision

The owner made these choices on 2026-10-13.

1. **Calls come in as Transcripts and as Recordings.**
2. **Outcomes come from a CSV in one fixed, documented template.**
3. **A Call is linked to its Deal by a deal identifier given at upload.**
4. **A Moment is a window of consecutive speaker turns,** with no model labelling.
5. **Duplicate and changed Outcomes.** A CSV row whose deal id already exists with a won or lost Outcome is rejected as a duplicate. A Deal still open may be given its Outcome by a later CSV. An Owner or Admin can also set or correct any Deal's Outcome in the portal.
6. **A Call for a Deal with no Outcome yet is accepted,** stored and indexed, and held back from search until its Deal is won. Lost and open Deals are kept.
7. **The uploader says which speaker is the Rep,** at upload.
8. **Transcription stays as ADR 0010 chose it:** AssemblyAI Universal-3.5 Pro with speaker diarization, about $0.23 per audio hour, on the EU endpoint for the EU Region. The owner confirmed it after the report above, still pending a trial on real Calls and ADR 0010's golden set. It is built behind a port with a stand-in until an account and key exist.
9. **The Rep in a Recording.** When the file has one channel per side, the uploader says at upload which channel is the Rep. Otherwise the Call waits after transcription, in a named state, until an Owner or Admin picks the Rep from the detected speakers in the portal. For per-side recordings this settles ADR 0010's stereo note: the channels are the speakers.
10. **Large Recordings are streamed through the service to storage in parts** and never held whole in memory. This extends choice 1 of ADR 0016 (upload through the service); it does not reopen it.
11. **Each Moment also stores the Rep's turns that follow it,** so a later Copilot can show what the Rep said next.
12. **Uploading Recordings or Transcripts requires a recorded confirmation** by an Owner or Admin that the Organization has the right to share them (who and when), made before the first upload. A lawyer is to check its wording before real customers use it.

### The lead's refinements (defaults an implementing ticket may revisit)

None of the following was chosen by the owner.

- **Transcript formats:** plain text with `Speaker: text` lines, WebVTT, SRT, and a documented JSON turn list; 5 MB. A Call with fewer than two speakers or no turns fails with a stated reason.
- **The Rep in a Transcript:** the uploader names the Rep's speaker label; a label not found in the file fails the Call with a stated reason. With three or more speakers, one label is the Rep and every other speaker is on the Prospect's side.
- **Recording formats:** mp3, m4a, wav, ogg, webm and flac; 500 MB and 3 hours.
- **CSV template:** `deal_id` (required, the Organization's own identifier, unique per Organization), `outcome` (`won`, `lost`, `open`), `closed_at`, `amount`, `currency`, and optional `name`; 10 MB and 50,000 rows.
- **An import is asynchronous and produces a report for each row.** Valid rows are applied and bad rows are reported, never silently dropped. A deal id repeated within one CSV is rejected for every repeat after the first. A row for an existing open Deal may set its Outcome and update its other columns; a row with `open` for an existing open Deal updates the other columns.
- **A Call uploaded for a deal id that has no Deal creates an open Deal.** The import report and the portal list Deals that have Calls but have never appeared in a CSV, so a typo is visible.
- **Upload, delete, restore, retention and purge follow ADR 0016 exactly:** upload through the service, soft delete, 30 days, Owner and Admin write. A Deal cannot be deleted on its own in phase 1; it goes with its Organization's erasure. Deleting a Call removes its Moments from search as ADR 0016 does for a document.
- **The Outcome is stored with each Moment in the vector index** so search can filter on won. A change of Outcome re-tags that Deal's Moments through a queued job, never on the request path. The job reads the Deal's current Outcome from the database, is idempotent, and carries an Outcome sequence so two changes cannot finish in the wrong order (as ADR 0016's deletion sequence).
- **Search treats Postgres as the source of truth for the Outcome.** It is right at once for a lost Deal. For a Deal that has just become won it may lag until the re-tag finishes.
- **The Transcript produced from a Recording is kept and reused,** so a restore or a retry never pays for a second transcription.
- **A transcription call has a timeout, a bounded jittered retry and an idempotency key.** A Recording whose transcription fails or times out ends `failed` with a stated reason.
- **The original Recording is kept like an original document until purge.** It is never logged. It is sent to the vendor by a short-lived presigned URL, and the vendor must not train on it and must delete it after the job.
- **Erasure and purge also delete the vendor's copy** and record that the vendor confirmed it. A transcription in flight is cancelled or its result discarded. Erasure covers Calls, Deals, Transcripts and Recordings.
- **The same content under a different deal id is refused** with a stated reason, not silently linked to the first Deal. The same Call uploaded as both a Transcript and a Recording becomes two Calls, because the content hashes differ and no check can see they match; matching on the transcribed text could be added later.
- **Consent.** ADR 0003 governs calls an Agent places. The confirmation in choice 12 is the control for historical uploads. Whether more is needed is legal advice the owner will take.

## Considered options

- **Audio only, or Transcripts only.** Rejected: Organizations hold both, and either alone would leave some history out.
- **CSV with column mapping.** Rejected: a mapping screen is a feature to build and test; one template is documented once.
- **HubSpot only.** Rejected: not every Organization uses it; the HubSpot sync (step 1.16) feeds the same path later.
- **A manifest file linking Calls to Deals.** Rejected: a second file to keep in step with the uploads.
- **Matching a Call to a Deal later.** Rejected: matching by guesswork is wrong in ways nobody sees.
- **Model-labelled windows.** Rejected: slower, costs more, and labels would need their own evaluation.
- **Latest CSV row wins.** Rejected: one wrong file would silently change closed Deals.
- **Refusing Calls with no Outcome.** Rejected: most Calls are uploaded before their Deal closes.
- **Guessing the Rep with a model.** Rejected: a wrong guess puts a Prospect's words in the Rep's column.
- **Switching vendor now.** Not done: ADR 0010 names AWS Transcribe as the runner-up (no new subprocessor, documented EU regions, dearer) and the report names Deepgram Nova-3 (cheaper on its Growth plan, diarization included). Neither is overruled. The choice between them is made only if AssemblyAI fails the trial.
- **Self-hosting an open model.** Rejected for now: by the report's estimate it is not clearly cheaper below about 300,000 audio hours a month.
- **Holding every Recording in memory, as ADR 0016 does for documents.** Rejected: at 500 MB a few concurrent uploads would exhaust an instance.

## Consequences

- The vendor adapter waits on an account and key. Until then phase 1 runs on a stand-in behind a port in the playbook service (ADR 0016).
- **Before real audio goes to the vendor,** all of these hold: written confirmation of EU processing, deletion timing and no-training terms; the lawyer-checked confirmation wording of choice 12; and the trial and golden set. AssemblyAI is a subprocessor that sees call audio (ADR 0010), and Recordings hold the voices of Prospects.
- AssemblyAI bills stereo per channel (ADR 0010). Per-side recordings use the channels as speakers (choice 9); how a recording of any other shape is billed or downmixed is decided when the adapter is built.
- The 2026-10-13 report corrects ADR 0010's reason for rejecting Deepgram: diarization is included. Its AWS Transcribe figure also supersedes ADR 0010's price comparison.
- A Call holds personal data in both its Recording and its Transcript until purge or erasure.
- A Moment's Outcome exists in two places, Postgres and the index. The index copy may lag; the database copy decides.
- Imports, transcription, re-tagging and Call purge are new background work. Each registers a work hint kind with its trigger and a test that the hint cannot be lost (ADR 0017).
- The new tables live in the `playbook` schema through the db library (ADR 0007), after a contract release.
- Quotas for Calls, Deals and Recordings are left to the ticket.
- The terms Document, Call, Recording, Transcript, Deal, Outcome and Moment are added to `GLOSSARY.md`.

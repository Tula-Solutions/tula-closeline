# ADR 0018 — Sales history ingestion: calls, deal outcomes and Moments

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0003, ADR 0007, ADR 0010, ADR 0016

## Context

Step 1.14 of the phase 1 plan (hub issue 15) loads an Organization's past Calls and Deal Outcomes into its Playbook, so search (step 1.15) can return similar Moments from won Deals. ADR 0016 fixed how Documents are uploaded, deleted and purged. ADR 0010 chose AssemblyAI for batch transcription; a second look is in `docs/research/2026-10-13-speech-to-text-vendors.md`. Eight choices belong to the product owner; the refinements after them are the lead's reading, marked as such.

## Decision

The owner made these choices on 2026-10-13.

1. **Calls come in as Transcripts and as Recordings.**
2. **Outcomes come from a CSV in one fixed, documented template.**
3. **A Call is linked to its Deal by a deal identifier given at upload.**
4. **A Moment is a window of consecutive speaker turns,** with no model labelling.
5. **Duplicate and changed Outcomes.** A CSV row whose deal id already exists with a won or lost Outcome is rejected as a duplicate. A Deal still open may be given its Outcome by a later CSV. An Owner or Admin can also set or correct any Deal's Outcome in the portal.
6. **A Call for a Deal with no Outcome yet is accepted,** stored and indexed, and held back from search until its Deal is won. Lost and open Deals are kept.
7. **The uploader says which speaker is the Rep,** at upload.
8. **Transcription stays as ADR 0010 chose it:** AssemblyAI Universal-3.5 Pro with speaker diarization, about $0.23 per audio hour, on the EU endpoint for the EU Region. The owner confirmed it on 2026-10-13 after the report above, still pending a trial on real Calls and ADR 0010's golden set. It is built behind a port with a stand-in until an account and key exist.

### The lead's refinements (defaults an implementing ticket may revisit)

None of the following was chosen by the owner.

- **Transcript formats:** plain text with `Speaker: text` lines, WebVTT, SRT, and a documented JSON turn list; 5 MB. A Call with fewer than two speakers or no turns fails with a stated reason.
- **Recording formats:** mp3, m4a, wav, ogg, webm and flac; 500 MB and 3 hours.
- **CSV template:** `deal_id` (required, the Organization's own identifier, unique per Organization), `outcome` (`won`, `lost`, `open`), `closed_at`, `amount`, `currency`, and optional `name`; 10 MB and 50,000 rows.
- **An import is asynchronous and produces a report for each row.** Valid rows are applied and bad rows are reported, never silently dropped.
- **Upload, delete, restore, retention and purge follow ADR 0016 exactly:** upload through the service, soft delete, 30 days, Owner and Admin write. Erasure covers Calls, Deals, Transcripts and Recordings.
- **The Outcome is stored with each Moment in the vector index** so search can filter on won. A change of Outcome re-tags that Deal's Moments through a queued job, never on the request path. Search treats Postgres as the source of truth for the Outcome, so a re-tag in progress cannot show a lost Deal as won.
- **A Moment keeps the Rep's turns that follow it,** so a later Copilot can show what the Rep said next.
- **The original Recording is kept like an original Document until purge.** It is never logged. It is sent to the vendor by a short-lived presigned URL, and the vendor must not train on it and must delete it after the job.
- **Open question, not decided:** an Organization needs the right to upload recordings of its Prospects, and recording consent differs by jurisdiction. Whether an attestation at upload is needed is the owner's legal call. ADR 0003's consent rule governs Calls an Agent places or a Rep takes with the Copilot, where Closeline is the platform making the Call. This is a historical upload the Organization already holds, so that rule does not apply to it, but the question of rights over the audio remains.

## Considered options

- **Audio only, or Transcripts only.** Rejected: Organizations hold both, and either alone would leave some history out.
- **CSV with column mapping.** Rejected: a mapping screen is a feature to build and test; one template is documented once.
- **HubSpot only.** Rejected: not every Organization uses it; the HubSpot sync (step 1.16) feeds the same path later.
- **A manifest file linking Calls to Deals.** Rejected: a second file to keep in step with the uploads.
- **Matching a Call to a Deal later.** Rejected: matching by guesswork is wrong in ways nobody sees.
- **Model-labelled segments.** Rejected: slower, costs more, and labels would need their own evaluation.
- **Latest CSV row wins.** Rejected: one wrong file would silently change closed Deals.
- **Refusing Calls with no Outcome.** Rejected: most Calls are uploaded before their Deal closes.
- **Guessing the Rep with a model.** Rejected: a wrong guess puts a Prospect's words in the Rep's column.
- **Switching vendor now.** Not done: ADR 0010 names AWS Transcribe as the runner-up (no new subprocessor, documented EU regions, dearer) and the report names Deepgram Nova-3 (cheaper on its Growth plan, diarization included). Neither is overruled. The choice between them is made only if AssemblyAI fails the trial.
- **Self-hosting an open model.** Rejected for now: it breaks even only near 100,000 audio hours a month.

## Consequences

- The vendor adapter waits on an account and key. Until then phase 1 runs on a stand-in behind a port in the playbook service (ADR 0016).
- AssemblyAI is a subprocessor that sees call audio (ADR 0010), and Recordings hold the voices of Prospects. EU processing, deletion timing and training terms must be confirmed in writing before any audio is sent.
- AssemblyAI bills stereo per channel (ADR 0010). Downmixing, or using the channels as speakers, is decided when the adapter is built. For Calls recorded with one channel per side, channels as speakers would also settle who the Rep is; this is not decided here.
- A Moment's Outcome exists in two places, Postgres and the index. The index copy may lag; the database copy decides.
- Quotas and plan limits for Calls, Deals and Recordings are left to the ticket.
- The terms Document, Call, Recording, Transcript, Deal, Outcome and Moment are added to `GLOSSARY.md`.

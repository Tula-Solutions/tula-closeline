# ADR 0016 — Document ingestion: upload through the service, soft delete, Owner and Admin write

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0001, ADR 0006, ADR 0007, ADR 0010

## Context

Step 1.13 of the phase 1 plan (hub issue 14) loads an Organization's documents into its Playbook. ADR 0010 chose the vendors and left the shape of the flow open. Four choices belong to the product owner; the rest is the lead's reading, marked as such.

## Decision

The owner made these four choices on 2026-10-13.

1. **Upload goes through the playbook service.** The portal posts the file to the service, which checks it and writes it to object storage. The browser does not write to storage itself.
2. **Phase 1 accepts PDF, DOCX, PPTX, TXT and MD**, up to 25 MB and 300 pages per file. HTML and images are not accepted yet.
3. **Deleting a document is a soft delete.** The document is hidden at once and purged later. Until it is purged, a mistaken delete can be undone.
4. **Owner and Admin may upload and delete documents.** Managers and Reps may see documents and their status.

### The lead's reading (defaults an implementing ticket may revisit)

None of the following was chosen by the owner.

- **Retention before purge: 30 days.**
- **Hidden at once is a state check, not a deletion.** The delete request makes one write in Postgres marking the document deleted, and lists exclude it from then on. Search drops any result whose document is deleted or gone, so a page of results may be shorter than asked for, and a deleted document cannot appear even while its vectors exist. That check stays permanently and is the guarantee. A queued job then removes the vectors as cleanup, never on a request path because delete-by-filter is work proportional to size. A cleanup applies only to the deletion it was queued for and does nothing if the document has been restored since. The file and the record are kept for the retention period.
- **Purge and restore are serialised on the document's state**, so only one wins, and a restore after the purge is refused because the file is gone. The purge confirms the vector cleanup has run, running it again if not, before it removes the file and the record, so no vectors outlive their document.
- **Restore** is allowed within the retention period. It re-ingests from the kept file, and the document shows as processing until that finishes.
- **Soft-deleted documents count toward quotas until purged**, as they still hold storage.
- **An erasure request covers soft-deleted documents.** It cancels ingestion in flight and removes the file, chunks, vectors and record without waiting for retention.
- **Chunks** are split on headings and paragraphs with the page kept; their size is left to the ticket.
- **The embedding model name and output dimension are recorded per Organization**, as ADR 0010 requires.
- **Duplicates** are detected by a hash of the content, per Organization. An upload that matches an existing document returns that document, restoring it if it is soft-deleted, under the purge-against-restore rule above. A match that loses to a purge creates a new document.
- **Quotas** per Organization are configuration, starting at 500 documents and 2 GB, with a distinct error code when exceeded.
- **Ingestion is a queued, idempotent, resumable job.** Proposed document states, for the portal to show: `uploaded`, `processing`, `ready`, `failed`, and `deleted` while it awaits purge. The set is a proposal.
- **Size and type are checked at upload**, the type by inspecting the content as well as the declared type, because uploads are untrusted data. **The page count is checked in the ingestion job**; a document over the limit ends in `failed` with a reason the portal can show.
- **The service holds the whole file in memory** at up to 25 MB, so each instance bounds concurrent uploads.
- **An internal route removes everything an Organization has** in the Playbook, for offboarding. It has no caller yet; core has no offboarding flow.

## Considered options

- **Browser to storage by presigned URL.** Rejected: the service would learn of the file only after it was stored, so it could not refuse an oversized or wrong-type file first.
- **Accept HTML and images in phase 1.** Rejected: HTML needs sanitising and images need OCR.
- **Hard delete at once.** Rejected: a mistaken delete could not be undone.
- **Every member may upload.** Rejected: the Playbook guides every Agent. The glossary has the Admin manage it; including the Owner is the owner's choice.

## Consequences

- The storage port needs no presigned URLs.
- If much larger files are ever needed (we guess above a few tens of MB; no measurement backs this), in-memory handling stops working. Uploads would have to stream or go straight to storage, reopening choice 1.
- Personal data in a deleted document is held for the retention period after the delete, unless an erasure request purges it sooner.
- The real vector, embedding and OCR adapters are blocked on credentials (hub issue 48 for the vector store). Phase 1 work proceeds on memory adapters and fakes behind ports.
- Ports for the embedder, parser and OCR live in the playbook service unless a second consumer appears (ADR 0006).

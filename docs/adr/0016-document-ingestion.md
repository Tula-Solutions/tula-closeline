# ADR 0016 — Document ingestion: upload through the service, soft delete, Owner and Admin write

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0001, ADR 0006, ADR 0007, ADR 0010

## Context

Step 1.13 of the phase 1 plan (hub issue 14) loads an Organization's documents into its Playbook: upload, parse, chunk, embed, index. ADR 0010 chose the vendors and left the shape of the flow open. Four choices about it belong to the product owner. The rest of this record is the lead's reading of how to apply them, and is marked as such.

## Decision

The owner made these four choices on 2026-10-13.

1. **Upload goes through the playbook service.** The portal posts the file to the service, which checks its size and type and writes it to object storage. The browser does not write to storage itself.
2. **Phase 1 accepts PDF, DOCX, PPTX, TXT and MD**, up to 25 MB and 300 pages per file. HTML and images are not accepted yet.
3. **Deleting a document is a soft delete with a later purge.** The document is hidden at once. Its file, chunks and vectors are removed after a retention period, so a mistaken delete can be undone.
4. **Owner and Admin may upload and delete documents.** Managers and Reps may see documents and their status.

### The lead's reading (defaults an implementing ticket may revisit)

None of the following was chosen by the owner.

- **Retention before purge: 30 days.**
- **Hidden at once means out of search at once.** A soft-deleted document must stop being returned by search immediately, not only after the purge. The lead chose to **remove the document's vectors at once with `deleteByFilter`** (on the document's identifier) and keep the file and the document record for restore. The vector port offers `upsert`, `search` with equality filters, `delete`, `deleteByFilter` and `deleteAll`, and has no way to change one attribute of a stored vector. A "deleted" attribute filter would need every vector re-upserted, with its vector, to set and to clear the flag. It would also make "hidden" depend on every search remembering to add the filter, which a missed filter breaks silently. Removing the vectors makes "hidden" true however search is written. The cost is that a restore re-runs ingestion from the retained file, which embeds the document again.
- **Restore** is allowed within the retention period.
- **An erasure request overrides retention** and purges at once.
- **Chunks** are about 300 tokens with overlap, split on headings and paragraphs, with the page number kept.
- **Embedding model and output dimension are recorded per Organization.** ADR 0010 already requires the model name and dimension count to be stored. The dimension is not picked here; the ticket that adds the embedder sets it.
- **Duplicates** are detected by a hash of the content, per Organization. A re-upload of the same content returns the existing document.
- **Quotas** per Organization are configuration, starting at 500 documents and 2 GB, with a distinct error code when exceeded.
- **Ingestion is a queued, idempotent, resumable job.** Proposed document states, for the portal to show: `uploaded`, `processing`, `ready`, `failed`, and `deleted` while it awaits purge. This set is a proposal.
- **The type is decided by inspecting the content** as well as the declared type, because uploads are untrusted data.
- **The service holds the whole file in memory** at up to 25 MB, so each instance bounds concurrent uploads. Memory per instance, not request rate, sets that bound.
- **An internal route removes everything an Organization has** in the Playbook, for offboarding. It has no caller yet, because core has no offboarding flow.

## Considered options

- **Browser to storage by presigned URL.** Rejected: the service would learn of the file only after it was stored, so it could not refuse an oversized or wrong-type file first.
- **Accept HTML and images in phase 1.** Rejected: HTML needs sanitising and images need OCR, which phase 1 leaves out.
- **Hard delete at once.** Rejected: a mistaken delete could not be undone.
- **Every member may upload.** Rejected: the Playbook is the Admin's to manage (GLOSSARY), and what it holds guides every Agent.

## Consequences

- The storage port needs no presigned URLs.
- If files above about 50 MB are ever needed, in-memory handling stops working. Uploads would have to stream or go straight to storage, which reopens choice 1.
- Personal data in a deleted document is held for the retention period after the delete, unless an erasure request purges it sooner.
- The real vector, embedding and OCR adapters are blocked on credentials (hub issue 48 for the vector store). Phase 1 work proceeds on memory adapters and fakes behind ports.
- The ports for the embedder, parser and OCR live in the playbook service unless a second consumer appears (ADR 0006).
- The model and OCR choices of ADR 0010 are unchanged. Its note that a model switch means re-embedding every Playbook also applies to a restore after a model switch.
- A purge job removes the file, chunks and any remaining vectors in bounded batches.
- Role checks for upload and delete rely on the role in the verified token; a test must show a Manager and a Rep are refused and a second Organization cannot see the document.
- The plan gains the prerequisite rows 1.32 to 1.36 (contract, db, service skeleton, vector adapter, blocked adapters).

# ADR 0010 — Vendors for Playbook ingestion: vector database, embeddings, parsing, transcription

**Status:** Accepted
**Date:** 2026-10-12

## Context

Phase 1 loads an Organization's documents and call transcripts into its Playbook and searches them while the Copilot is on a call, inside a budget of about 1.5 s. That needs four outside services: a vector database, an embedding model, a document parser and a batch transcriber with speaker separation. ADR 0001 requires every vendor behind a provider interface to work in both Regions, so Region residency ranks above a benchmark lead.

The comparison, prices and sources are in `docs/research/2026-10-12-knowledge-ingestion-vendors.md`. Facts that report could not verify are marked "(unverified)" below, as there.

## Decision

- **Vector database: turbopuffer**, one namespace per Organization, in the AWS region that matches the Organization's Region. It has unlimited namespaces, BM25 and vector search fused on the server, and stemming for English, Spanish, French and German. Its only idle cost is a $16 per month floor.
  - Runner-up: Amazon S3 Vectors.
  - Switch if: we want no new subprocessor and data inside our own AWS account; the retrieval evaluation shows keyword search is unnecessary and dense-only recall holds; the $16 floor or turbopuffer's pricing becomes a problem; or S3 Vectors' measured warm p99 from our own compute in the same region is under about 150 ms. S3 Vectors is about 4 times cheaper at scenario (b) ($76 against $314) but has no hybrid search and AWS publishes no percentile latency.
- **Embedding model: Cohere Embed v4 on Amazon Bedrock**, on the EU and US profiles. The research report preferred Voyage voyage-4 on benchmark score. Voyage documents no EU processing, while Bedrock offers EU and US profiles for Cohere inside our existing AWS relationship, so residency decided it. Cohere scored 90.9 on French and 82.2 on German on the one benchmark read (secondary).
  - Runner-up: Voyage voyage-4, if EU processing is confirmed in writing.
  - Switch if: Voyage confirms EU processing in writing and beats Cohere on our golden set, Spanish included; or Bedrock's EU profile turns out to route outside the EU geography. In the second case, if strict single-region residency is required, OpenAI text-embedding-3-large via `eu.api.openai.com` has documented EU processing but is weaker (65.4 average).
- **Document parsing: plain text extraction first**, inside the playbook service, for documents with a text layer; **Mistral OCR 3** ($2 per 1,000 pages) only for pages that need it, meaning scanned pages and complex tables. Mistral processes in the EU by default and in the US on its US endpoint.
  - Runner-up: self-hosted Docling in our AWS account.
  - Switch if: Mistral's price or terms change (the price of its newer OCR 4 is unconfirmed); a customer forbids any third-party document processor; or our own corpus shows Mistral losing on tables or slides. Reducto is the next hosted choice, but its EU residency needs the Growth plan and its VPC option needs Enterprise.
- **Batch transcription with speaker separation: AssemblyAI** (Universal-3.5 Pro with standard diarization, $0.23 per audio hour), on its EU endpoint for the EU Region.
  - Runner-up: AWS Transcribe.
  - Switch if: customers refuse third-party processing of call audio, or AssemblyAI's speaker separation fails our golden set. Transcribe costs about 57% more ($0.36 against $0.23 per hour, if $0.006 per minute is the flat rate), but adds no subprocessor and has documented EU regions and a 30-speaker limit. Deepgram ($0.26 to $0.31 per hour) is the other managed option.

## Considered options

Each section of the research report compares the alternatives. Rejected as the choice: Pinecone and Weaviate (fixed monthly minimums of $50 and $45), Qdrant and OpenSearch Serverless (rates or minimums not published or heavy), Upstash (index caps), LlamaParse, Unstructured and Textract (price, residency or format limits), Deepgram, OpenAI and Gemini for transcription (price or unconfirmed diarization).

## Consequences

- Every one of the four sits behind a port in the hexagonal layout of ADR 0006, so a switch is an adapter change. The exception is the embedding model: vectors from two models cannot be compared, so a switch means re-embedding every Organization's Playbook. The model name and dimension count are therefore stored with each namespace.
- turbopuffer, Mistral and AssemblyAI are new subprocessors that see customer data (embeddings and text, document pages, call audio) and must be listed as such. Bedrock is not a new subprocessor.
- Open items, to be closed before an EU Organization's data flows:
  - Written confirmation that turbopuffer's EU regions keep processing in the EU. Its regions page lists the regions and says nothing about processing locality.
  - Whether Bedrock's EU profile for Cohere Embed v4 routes within the EU geography rather than staying in a single region (secondary source).
  - The Cohere Embed v4 price on Bedrock was not confirmed from a primary source.
- A turbopuffer namespace that has been idle answers its first query in roughly 0.9 s (vendor figure, p50 874 ms at 1M documents; warm p50 is 14 ms). The namespace is warmed when a call starts, to protect the Copilot's budget. Cache eviction time is not stated (unverified).
- AssemblyAI bills stereo per channel, so a two-channel recording costs double. Whether to downmix or to use the channels as speakers is decided when the adapter is built.
- The rule that decides which pages go to OCR is ours to build and test.
- No vendor's quality has been measured on our own material, and no independent benchmark covered Spanish, slides, or AssemblyAI's speaker separation. A golden set is evaluated before launch: retrieval in English, Spanish, French and German; tables and slides; speaker separation.
- Cost, from the report's assumptions (4,608 bytes per vector, 300 tokens per chunk, 50 tokens per live query):

  | Scenario | turbopuffer | Embeddings | Mistral OCR 3 | AssemblyAI | Total |
  | --- | --- | --- | --- | --- | --- |
  | (a) Idle month, 200 Organizations of 20,000 vectors | $16 | $0 | $0 | $0 | $16 |
  | (b) Active month, 2,000 Organizations of 100,000 vectors, 200,000 pages, 20,000 audio hours | $314 | estimate, tens of dollars | $400 | $4,600 | $5,314 plus embeddings |

  The embedding price is unconfirmed, so (b) is shown without it; 300 million tokens add tens of dollars (the other models in the report cost $6 to $55 for the same tokens). The Mistral line assumes every page goes to OCR, so it is an upper bound given text extraction first. The AssemblyAI line doubles if stereo is billed per channel. The report notes that scenario (b)'s 50M new tokens produce only about 167K new vectors, and prices storage for 200M vectors and writes for 167K.

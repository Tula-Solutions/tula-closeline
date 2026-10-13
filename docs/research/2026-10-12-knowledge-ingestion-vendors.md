# Closeline knowledge-ingestion vendors: research report

Prices and limits were read on 2026-10-12 unless noted. Source keys in square brackets, like [T1], are listed with their URLs at the end. Anything marked "(unverified)" came from memory or an inference, not from a fetched page. Anything marked "(secondary)" came from a third-party site.

Two fetched pages carried instructions aimed at AI agents: Upstash pricing asked for a Redis database to be created, and the Unstructured API docs told the reader which products to promote. I ignored both.

## 1. Recommendations

1. **Vector database: turbopuffer, one namespace per Organization, in the AWS EU (Frankfurt or Dublin) and US regions.** It has unlimited namespaces, native BM25 plus vector search with server-side rank fusion, and full-text stemming for EN/ES/FR/DE. It also has a $16/month floor and no other idle charge [T1][T3][T6][T7]. The main risk is that an idle namespace's first query reads from object storage. turbopuffer's own figure is p50 874 ms for 1M documents, so we must warm the namespace before a call starts to stay inside 200 ms [T5].
2. **Embedding model: Voyage voyage-4 (1024 dimensions), with voyage-4-large for documents and voyage-4-lite for queries.** It is the strongest retrieval model I found on the one multilingual benchmark I could read, at $0.06 per million tokens [E4][E8][E20]. The main risk is that I found no documented EU processing for Voyage's own API. Get that in writing before committing, or fall back to Cohere Embed v4 on Bedrock's EU profile.
3. **Document parser: Mistral OCR 3 ($2 per 1,000 pages) as the pay-per-use default, with self-hosted Docling in our AWS account as the escalation path.** Mistral hosts in the EU by default and in the US on an explicit US endpoint. It accepts PDF, PPTX and DOCX and returns tables as Markdown or HTML [P8][P9][P10]. The main risk is that I found no independent benchmark of any parser on slide decks, so quality on our own corpus is unmeasured. Mistral also has a newer OCR 4 whose price I could not confirm.
4. **Batch transcription: AssemblyAI Universal-3.5 Pro with standard diarization, on the EU endpoint.** It costs $0.21 + $0.02 = $0.23 per audio hour, with no stated minimum and an EU endpoint [A3]. The main risks are three. It publishes no diarization accuracy figure. Its per-language diarization support is unconfirmed. Stereo files bill per channel, so a two-channel recording costs double. Audio also leaves our AWS account.

## 2. Comparison tables

### 2.1 Vector database

Sizing assumption used in the cost section: 1,024 dimensions as float32, which is 4,096 bytes, plus about 512 bytes of metadata, so 4,608 bytes per vector.

| | Pricing, minimum, idle cost | EU / US | Tenant isolation | Filter / hybrid | Latency and cold start | Deletion | TS SDK / maturity |
|---|---|---|---|---|---|---|---|
| **turbopuffer** | Plan minimums: Launch $16/mo, Scale $256, Enterprise from $4,096 plus a 35% premium [T1]. Rates from the page's calculator code (secondary reading of first-party JS): storage $0.33/GB-mo, writes $2/GB, queried $0.001 per TB, returned $0.05/GB, 1.28 GB minimum billed per query [T2]. Idle cost is $16. | AWS eu-central-1, eu-west-1, eu-west-2, us-east-1, us-east-2, us-west-2 [T4]. SOC2 report and a GDPR DPA are listed [T1]. | Namespace per Organization. Namespace count is unlimited ("seen 250M+") [T3]. 128B documents per namespace. Per-namespace limit is 16 concurrent queries unless the namespace is pinned [T3]. | Filters in the query. BM25 plus vector, fused with RRF on the server [T6]. FTS stemming for en/es/fr/de [T7]. Supports 10,752 dense dimensions [T3]. | Cold: p50 874 ms at 1M documents. Warm: p50 14 ms. Eventually consistent reads can be under 10 ms. A pre-flight query warms the cache [T5]. Cache eviction time is not stated. | `DELETE` on the namespace "entirely"; "no way to recover" [T8]. Physical-erasure timing is not stated. | `@turbopuffer/turbopuffer` 2.11.0, MIT, updated 2026-10-09 [npm]. Young vendor. The calculator note that the minimum fell from $64 to $16 in June 2026 is secondary [T9]. |
| **S3 Vectors** | Storage $0.06/GB-mo, PUT $0.20/GB, queries $2.50 per million, processing $0.004/TB for the first 100K vectors then $0.002/TB, returned data $0.01/GB. These came from worked examples because the rate table did not render [S1]. No minimum. Idle cost is storage only. | In-region in 29 commercial regions, including eu-central-1, eu-west-1, eu-west-3 and us-east-1/2 and us-west-2 [S3]. Runs in our AWS account. | Index per Organization. 10,000 indexes per bucket, 10,000 buckets per region, 2B vectors per index [S2]. IAM can be scoped per index [S4]. | Metadata filters. 2 KB filterable metadata per vector, up to 50 keys, string/number/boolean/list types [S2][S4]. No keyword or hybrid search. AWS points hybrid needs to OpenSearch [S4]. | "Sub-second for infrequent queries, as low as 100 ms for more frequent" [S4]. No percentile figures. Writes are strongly consistent [S4]. | `DeleteVectors` (500 per call) and index deletion exist [S2]. I fetched no physical-erasure statement. | `@aws-sdk/client-s3vectors` 3.1150.0, Apache-2.0 [npm]. Features page gives no GA date [S5]. |
| **Pinecone serverless** | Starter free (2 GB, us-east-1 only, 100 namespaces). Builder $20/mo (10 GB, 1,000 namespaces). Standard $50/mo minimum: storage $0.33/GB, writes $4–4.50 per million units, reads $16–18 per million units. Enterprise $500/mo minimum [V1]. Idle cost is $50. | Standard and above: "all available regions", AWS examples include eu-central-1, eu-west-1, us-east-1, us-west-2 [V1]. | Namespaces per index: 100,000 on Standard, 1M on Enterprise [V1][V2]. | Flat metadata filters, 40 KB per record [V2]. Dense, sparse and full-text fields in one schema, with ranking set per query [V2]. | No cold-start or latency figures found [V2][V4][V5]. Eventually consistent [V4]. | Namespace delete is irreversible [V3]. Timing and compaction lag: size reporting lags deletes [V3]. | `@pinecone-database/pinecone` 9.0.0 [npm]. Mature. Fixed minimum is a negative. |
| **Qdrant Cloud** | Free: 1 node, 1 GB RAM, 4 GB disk; suspended after 1 week idle, deleted after 4 [Q2]. Standard is billed hourly on CPU, RAM and disk with no rates published [Q1]. No scale-to-zero stated. A secondary source quotes about $114/mo for a 2 GB RAM cluster [Q4] (unverified). | AWS/GCP/Azure; specific regions not listed [Q1][Q2]. | Qdrant advises one shared collection with a tenant payload filter. Collections per cluster default to 1,000 [Q3]. That is a filter, not hard isolation. | Payload filters. BM25/miniCOIL sparse support. IDF statistics need a per-tenant filter [Q3]. | No figures found. | No tenant-deletion procedure documented [Q3]. | `@qdrant/js-client-rest` 1.19.0 [npm]. Mature. Fixed cluster cost is a negative. |
| **Weaviate Cloud** | Free sandbox (100K objects, 3 tenants). Flex from $45/mo minimum. Dimensions from $0.00465 per million, storage from $0.12/GiB, backups extra [W1]. Idle cost is $45. | Flex has 7 regions (AWS/GCP) with names not listed; Premium Dedicated has about 40 [W1]. | A tenant is a shard with its own vector index. A tenant can be ACTIVE, INACTIVE (on disk) or OFFLOADED (S3) [W2][W3]. 1,000 collections on Flex. Practical limit is open files per node [W3]. | Filters. Hybrid is in the product; I did not fetch its page. | Activation latency for inactive tenants not stated [W2]. | Deleting a tenant deletes its shard and objects [W2][W3]. | `weaviate-client` 3.15.0 [npm]. Mature. |
| **Upstash Vector** | Pay-as-you-go: $0.40 per 100K requests, storage $0.25/GB, no stated minimum. Fixed $60/mo. Free tier has 10K daily requests [U1]. | Pay-as-you-go: N. Virginia, Ireland, Iowa [U1]. | 10,000 namespaces per index on pay-as-you-go [U1]. A request targets one namespace [U2]. | Dense plus sparse hybrid with RRF or DBSF fusion. BM25 not mentioned; filters not described [U3]. | None stated [U3]. | Delete-namespace API [U2]. | `@upstash/vector` 1.2.3 [npm]. Hard caps: pay-as-you-go allows 2B "vectors × dimensions" and 50 GB per index [U1]. At 1,024 dimensions that is under 2M vectors per index. |
| **OpenSearch Serverless** | $0.24/OCU-hour; $0.02/GB-mo managed storage [O1]. Classic: about 2 OCU minimum, which is $350/mo by my arithmetic (2 × $0.24 × 730) [O1]. NextGen: no minimum OCU, scales to zero when idle [O2]. A secondary source says zero after 10 minutes idle and puts hot storage at $0.30/GB-mo [O4]. NextGen OCU price unverified. | Subset of OpenSearch regions; list not fetched [O3]. | Collection per tenant is heavy; index-per-tenant limits not fetched [O3]. | Full filters, text plus k-NN. Read-after-write is 10 s on NextGen [O2]. | None stated. Wake time from zero not documented [O2]. | Collection or index deletion; erasure semantics not fetched. | `@opensearch-project/opensearch` 3.9.0 [npm]. Mature but complex. |
| **pgvector (baseline)** | No vendor fee. Aurora Serverless v2 is $0.12/ACU-hr, storage $0.10/GB-mo, I/O $0.20 per million [G2]. The page contradicts itself on minimum ACU (0 or 0.5). | Wherever our Postgres runs. | List partitioning or separate tables; a shared HNSW index leaks recall across tenants [G1]. | HNSW filters apply after the index scan; iterative scan fixes recall. Hybrid uses `tsvector` plus RRF. HNSW caps at 2,000 dimensions (`halfvec` 4,000) [G1]. | Depends on instance memory. | `DELETE`, then `REINDEX` and `VACUUM`; dead tuples can reduce result counts [G1]. | Not applicable. |

### 2.2 Embedding model

Benchmark: the RTEB leaderboard (launched 2025-10-01 [E21]), read through the aggregator benchmarklist.com with rows sampled 2026-05-06 [E20]. This is secondary. The averages cover all RTEB languages and domains, not only our four. The aggregator shows French and German averages but no Spanish column, and Titan is not listed. The Voyage rows may be vendor-submitted.

| Model | Price per 1M tokens | Dimensions | RTEB avg / FR / DE [E20] | EU residency | Rate limits | Query latency |
|---|---|---|---|---|---|---|
| **OpenAI text-embedding-3-small** | $0.02 [E1] | 1536 (512d row exists in [E20]); shortenable per the aggregator's 512d entry; OpenAI page not fetched | 59.2 / 72.7 / 70.8 | EU and US regional processing on `eu.`/`us.api.openai.com`. Paid option via sales; non-US regions need approval and a retention amendment [E3]. | Build tier 5,000 RPM / 1M TPM; Launch and Grow 10,000 RPM; Grow 10M TPM [E2]. Quoted for 3-large; shared across the family is unverified. | Not found. |
| **OpenAI text-embedding-3-large** | $0.13 [E1] | 3072; 512d variant benchmarked | 65.4 / 74.9 / 75.9 | As above [E3] | [E2] | Not found. |
| **Voyage voyage-4-large** | $0.12 [E4] | 1024 default; 256/512/2048 [E5] | 79.7 / 89.9 / 84.2 | Not documented in Voyage docs [E7]. MongoDB announced EU/US residency for its Atlas embedding service in public preview (secondary) [E24]. | Tier 1: 3M TPM / 2,000 RPM [E6] | Not found. |
| **Voyage voyage-4** | $0.06 [E4] | 1024 default; 256/512/2048 [E5] | 77.9 / 89.2 / 82.9 | As above | Tier 1: 8M TPM / 2,000 RPM [E6] | Not found. |
| **Voyage voyage-4-lite** | $0.02 [E4] | Same | 75.1 / 88.3 / 80.0 | As above | Tier 1: 16M TPM [E6] | Not found. |
| **Cohere Embed v4 / v5** | v5 Pro $0.12, v5 Fast $0.08 (secondary [E12]); Cohere's pricing page shows only dedicated hosting for Embed 5 [E11]; v4 price not found. | v4: 256/512/1024/1536; v5: 256–2048 [E9] | v4 (int8, 512d row): 73.0 / 90.9 / 82.2; v3 multilingual: 60.0 / 65.5 / 69.8. v5 not listed. | No Cohere-native EU endpoint confirmed. Bedrock's EU profile for v4 may route across EU regions, so it is not strictly in-region (secondary) [E23]. | 2,000 inputs/min for text [E10] | Not found. |
| **Google Gemini Embedding 2** | $0.20; batch $0.10 [E13] | 3072 default, 128–3072 [E14] | gemini-embedding-001: 75.9 / 87.8 / 81.2. gemini-embedding-2-preview: 68.4 / 56.6 / 71.0 (an odd result I cannot explain). | Vertex EU regions not confirmed (fetch truncated). | Not published on the page; viewable in AI Studio [E15] | Not found. |
| **Amazon Titan Text Embeddings v2** | $0.02 (launch blog, secondary [E17]); the Bedrock pricing page did not show it. | 1024/512/256; 8,192 tokens [E16] | Not benchmarked. AWS says it is "optimized for English"; cross-language queries "will return sub-optimal results" [E16]. | In-region in eu-central-1, eu-west-1, eu-west-3, us-east-1, us-west-2 [E18] | Throttled by RPM, not TPM [E16] | Not found. |
| **bge-m3 (open, MIT)** | Self-host compute only | 1024; 8,192 tokens; dense + sparse + ColBERT [E19] | 56.4 / 62.1 / 68.1 | Runs in our own account | None | Depends on our GPU |

Vendor-claimed (Voyage, 2026-01-15): voyage-4-large beats OpenAI v3-large by 14.05%, Cohere Embed v4 by 8.20% and Gemini Embedding 001 by 3.87% average NDCG@10 across the 29 RTEB datasets. The post does not mention multilingual evaluation [E8]. The MMTEB paper is the other benchmark to cite [E22]. I could not retrieve its per-model numbers, so I use it only as a pointer.

### 2.3 Document parser

| | Price per page | Tables / slides quality | EU processing | Inside our AWS account |
|---|---|---|---|---|
| **Mistral OCR 3** (`mistral-ocr-2512`) | $2 per 1,000 pages; $3 per 1,000 annotated [P8]. Batch discount not confirmed. A secondary page claims OCR 4 is $4 per 1,000 [P14]. | Takes PDF, PPTX, DOCX, images. Tables returned inline, or separately as Markdown or HTML (needs OCR 2512 or newer). 40+ languages [P9]. No independent benchmark found. | EU by default; US only when you use the US endpoint. Some features may transit non-EU subprocessors [P10]. | No. Custom self-hosted deployments are mentioned but not detailed. |
| **LlamaParse** | $1.25 per 1,000 credits. Fast 1 credit, Cost-effective 3, Agentic 10, Agentic Plus 45 per page, +3 for layout extraction [P2]. Free plan has 10K credits and no pay-as-you-go; Starter is $50/mo, Pro $500/mo [P1]. | Not independently benchmarked. | An EU sign-in and EU pricing page exist, but the page does not say data stays in the EU [P3]. | Private VPC on the enterprise tier only; also on AWS Marketplace [P1]. |
| **Unstructured (hosted)** | $0.015 per page after 10,000 free pages [P4]. A page is a slide, a PDF page, or file size ÷ 100 KB for other types [P5]. | Strategies fast/hi_res/vlm have no separate prices [P4]. | No regions stated [P4][P5]. | In-VPC deployment on the Business plan only [P4]. |
| **Unstructured (open source)** | Compute only. License not fetched. | Not benchmarked. | Not applicable | Yes |
| **Docling** | Compute only. MIT [P13]. | PDF, DOCX, PPTX, XLSX, HTML, EPUB, images. A `docling-serve` HTTP server exists [P13]. TableFormer was not on the page I fetched. | Not applicable | Yes |
| **Reducto** | Parse $10 per 1,000 pages; Extract $20 [P6]. $150 free credit on Standard (the FAQ says 15,000 credits, which disagrees) [P6]. | 30+ file types incl. presentations [P7]. Not benchmarked. | EU/AU data residency listed under Growth only, not Standard [P6]. | VPC and on-prem under Enterprise only [P6][P7]. |
| **AWS Textract** | Text detection $1.50 per 1,000 pages; Tables $15 per 1,000 (first 1M/mo), $10 above; Layout free with Tables. Prices cited for US West (Oregon) only [P11]. | PDF, JPEG, PNG, TIFF only, so no DOCX or PPTX [P12]. Text detection supports EN/FR/DE/ES/IT/PT; handwriting English only [P12]. | EU regions not verified for Textract (I only fetched the Transcribe region list). | Yes, it is an AWS service. |
| **Plain extraction** (mammoth, python-pptx, pdf text layer, HTML parsers) | $0 plus compute | Fine for text; weak on scanned pages and complex tables | Not applicable | Yes |

On quality: the only table benchmarks I found in 2026 are Dr. DocBench (MinerU led on tables) and OmniDocBench v1.6 (several parsers above 93 TEDS). Neither covers slides for the tools you listed [P14]. A Tensorlake blog post from November 2025 is vendor-authored and says open-source tools struggle on hard tables (secondary) [P14]. I have no basis to rank these parsers on tables or slides.

### 2.4 Batch transcription with diarization

| | Price per audio hour | Diarization | EN/ES/FR/DE | EU processing | Turnaround |
|---|---|---|---|---|---|
| **AssemblyAI** | Universal-3.5 Pro $0.21; Universal-2 $0.15. Standard diarization +$0.02/hr; experimental +$0.065/hr. Stereo bills per channel. $50 free credit, no stated minimum [A3]. | Up to 30 speakers (10 for 2–10 minute files); best with 30+ seconds of speech per speaker; no DER published [A5]. Per-language support not stated; the API errors when a feature is unsupported [A4]. | All four on both models [A4] | `api.eu.assemblyai.com`, same price [A3] | None published |
| **Deepgram** | Nova-3 monolingual $0.26/hr, multilingual $0.31/hr on pay-as-you-go; $0.22/$0.26 on Growth (prepaid from $4K/year). Diarization included. $200 free credit [A1]. | Included; which languages support it is not on the page [A2]. No DER published. | Monolingual en, es, fr, de, plus `multi` mode [A2] | `api.eu.deepgram.com` [A1] | None published (the Nova-3 blog URL 404'd) |
| **AWS Transcribe** | $0.006 per minute ($0.36/hr), stated only in the page's 2M-minute batch example (US East); the tier table did not render [A6]. Diarization included [A6]. | Up to 30 speakers [A7]; no DER published | en-US/GB, es-ES/US/MX, fr-FR/CA, de-DE are batch-supported [A8]. Diarization per language is not shown in that table. | Batch in eu-central-1, eu-west-1/2/3, eu-north-1, eu-central-2 [A9] | Max 8 h / 2 GB per file; 250 concurrent jobs; 25 job starts per second [A9]. Turnaround not published. |
| **OpenAI gpt-4o-transcribe-diarize** | $0.006/min ($0.36/hr). `gpt-4o-mini-transcribe` $0.003/min, `gpt-transcribe` $0.0045/min, `whisper-1` $0.006/min [E1]. | `diarized_json` output; up to four reference clips for known speakers; max speakers and languages not stated [A10] | Languages for the diarize model are not documented [A10] | Regional processing in the US and EU for transcription endpoints; needs sales approval [E3] | 25 MB file limit, so long calls need chunking [A10] |
| **Self-hosted WhisperX + pyannote** | GPU compute only. WhisperX is BSD-2; README claims 70× realtime on large-v2 batched [A12]. | pyannote community-1 is CC-BY-4.0 and gated on Hugging Face; DER ranges 7.9% to 46.8% across public datasets [A13] | Default alignment models for en, fr, de, es, it [A12] | Runs in our account | Ours to build |
| **Gemini 3.5 Transcribe** | $0.003/min input + $0.002/min output = $0.30/hr [E13] | Not documented on the pricing page | Not checked | Not checked | Not checked |

## 3. Cost estimates

Assumptions I added: 4,608 bytes per vector; 300 tokens per chunk; 50 tokens per live query; top-10 results of about 1 KB returned per query; query text is embedded on every query, which the scenario does not list.

Inconsistency in scenario (b): 200M vectors would need roughly 60B tokens to have been embedded. "50M new tokens" produces only about 167K new vectors (50M ÷ 300). I price storage for 200M vectors and writes for 167K.

### (a) Idle month: 200 Organizations × 20,000 vectors

4M vectors × 4,608 B = 18.4 GB.

| Vendor | Arithmetic | Monthly |
|---|---|---|
| S3 Vectors | 18.4 × $0.06 | **$1.1** |
| turbopuffer | 18.4 × $0.33 = $6.1, below the $16 minimum | **$16** |
| Upstash | 18.4 × $0.25 = $4.6; 4M × 1,024 = 4.1B exceeds the 2B cap, so 3 indexes | $4.6 |
| OpenSearch NextGen | 18.4 × $0.30 (secondary) = $5.5 | about $5.5 |
| OpenSearch Classic | 2 OCU × $0.24 × 730 | $350 |
| Weaviate Flex | usage about $19 (4,096M dims × $0.00465, unit assumed monthly) | **$45** floor |
| Pinecone Standard | 18.4 × $0.33 = $6.1 | **$50** floor |
| Qdrant | free tier holds 1 GB RAM / 4 GB disk, too small; paid price not published | not estimable |
| pgvector | roughly 37 GB (index assumed equal to data) × $0.10 | about $3.7 incremental, if the instance has headroom |

Everything else is $0 when idle: embeddings, parsing and transcription all have no minimum, except LlamaParse (Starter at $50/mo is needed for pay-as-you-go).

Recommended stack (a): about $16, or $1.1 with S3 Vectors.

### (b) Active month: 2,000 Organizations × 100,000 vectors

200M vectors × 4,608 B = 921.6 GB. Queries run against an average 100K-vector namespace of about 0.46 GB.

**Vector database**

| Vendor | Arithmetic | Monthly |
|---|---|---|
| turbopuffer | Storage 921.6 × $0.33 = $304.1. Writes 0.77 GB × $2 = $1.5. Queried: 5M × 1.28 GB minimum = 6,400 TB × $0.001 = $6.4. Returned 50 GB × $0.05 = $2.5. | **$314** |
| S3 Vectors | Storage 921.6 × $0.06 = $55.3. PUT 0.77 × $0.20 = $0.15. Queries 5 × $2.50 = $12.5. Processed 5M × 0.41 TB/1,000 = 2,048 TB × $0.004 = $8.2. | **$76** |
| Pinecone Standard | Storage $304.1. Writes 770K units × $4.50 per million = $3.5. Reads assume 0.46 RU per query: 2.3M × $18 per million = $41.4. The RU/WU formulas are unverified. | about $349 |
| Weaviate Flex | 204,800M dims × $0.00465 = $952, plus storage not computed | at least $952 |
| Upstash | Requests 5.17M ÷ 100K × $0.40 = $20.7; storage 921.6 × $0.25 = $230. Needs about 103 indexes under the 2B cap, so not viable without the Pro tier. | about $251, not feasible as priced |
| OpenSearch NextGen | Storage 921.6 × $0.30 = $276 (secondary). Compute: each continuously busy OCU is $175/mo; count unknown. | not estimable |
| pgvector | Storage about 1.8 TB × $0.10 = $184. Compute not estimated; the HNSW working set does not fit one modest instance. | not estimable |
| Qdrant | No published rates | not estimable |

**Embeddings:** 50M document tokens plus 250M query tokens (5M × 50) = 300M tokens.

| Model | Arithmetic | Monthly |
|---|---|---|
| text-embedding-3-small | 300 × $0.02 | $6 |
| text-embedding-3-large | 300 × $0.13 | $39 |
| voyage-4 | 300 × $0.06 | $18 |
| voyage-4-large for docs, voyage-4-lite for queries | 50 × $0.12 + 250 × $0.02 | $11 |
| Gemini Embedding 2 | 50 × $0.10 batch + 250 × $0.20 | $55 |
| Titan v2 | 300 × $0.02 | $6 |

**Parsing, 200,000 pages**

| Vendor | Arithmetic | Monthly |
|---|---|---|
| Mistral OCR 3 | 200 × $2 | **$400** |
| LlamaParse Fast / Cost-effective / Agentic | 200K × 1 / 3 / 10 credits × $0.00125 | $250 / $750 / $2,500 |
| Reducto parse | 200 × $10 | $2,000 |
| Unstructured | 200,000 × $0.015 | $3,000 |
| Textract Tables | 200 × $15 | $3,000 |
| Docling and plain extraction | compute only, not estimated | — |

**Transcription, 20,000 hours (1.2M minutes)**

| Vendor | Arithmetic | Monthly |
|---|---|---|
| AssemblyAI Universal-3.5 Pro + diarization | 20,000 × $0.23 | **$4,600** (double if stereo is billed per channel) |
| AssemblyAI Universal-2 + diarization | 20,000 × $0.17 | $3,400 |
| Deepgram Nova-3 multilingual, pay-as-you-go | 20,000 × $0.31 | $6,200 |
| AWS Transcribe | 1.2M min × $0.006 | $7,200 |
| OpenAI gpt-4o-transcribe-diarize | 1.2M min × $0.006 | $7,200 |
| Self-hosted WhisperX | 20,000 h ÷ 70× claim = 286 GPU-hours. Assuming 20× real throughput and $1 per GPU-hour (both unverified): about 1,000 GPU-hours | about $300 to $1,000 plus operations |

**Recommended stack (b):** turbopuffer $314 + voyage-4 $18 + Mistral OCR $400 + AssemblyAI $4,600 = about **$5,330 per month**. Transcription is 86% of it. With S3 Vectors in place of turbopuffer the total is about $5,090.

## 4. Runner-ups and switch triggers

- **Vector database: runner-up Amazon S3 Vectors.** Switch if any of these hold:
  - We want no new subprocessor and need data to stay inside our own AWS account.
  - Keyword search proves unnecessary in the retrieval evaluation, and dense-only recall holds.
  - The $16 floor or turbopuffer's pricing changes become a problem.
  - Measured warm p99 from our Lambda or Fargate in-region is under about 150 ms.

  It is about 4× cheaper at scenario (b) ($76 vs $314), but it has no hybrid search and AWS publishes no percentile latency [S4].
  - pgvector stays as the benchmark and rollback option. Pinecone is behind turbopuffer on the $50 minimum and unknown cold-start behaviour.
- **Embedding model: runner-up Cohere Embed v4 on Bedrock's EU profile.** Switch if Voyage cannot confirm in writing that EU requests are processed in the EU, or if the Voyage vs. Cohere comparison on our own golden set (including Spanish) shows no gap. It scored 90.9 on French and 82.2 on German in [E20]. Caveat: Bedrock's EU profile may route within the EU geography rather than stay in one region [E23]. If strict single-region residency is required, use OpenAI 3-large via `eu.api.openai.com`. It is weaker (65.4 avg) but its EU processing is documented [E3].
- **Parser: runner-up self-hosted Docling in our AWS account.** Switch when Mistral price or terms change (OCR 4 price is unconfirmed), when a customer forbids any third-party document processor, or when our test corpus shows Mistral losing on tables or slides. Reducto ($10 per 1,000 pages) is the next hosted choice, but EU residency needs the Growth plan and VPC needs Enterprise [P6].
- **Transcription: runner-up AWS Transcribe.** Switch if customers refuse third-party processing of call audio, or if AssemblyAI's diarization fails our golden set. It costs about 57% more ($0.36 vs $0.23 per hour, if the $0.006 per minute figure is the flat rate), but it needs no new subprocessor and has documented EU regions and a 30-speaker limit [A6][A7][A9]. Deepgram is the other managed option at $0.26 to $0.31 per hour.

## 5. What I could not verify

**Vector databases**
- Pinecone cold-start and latency behaviour, and its read/write-unit formulas (the page I fetched did not cover them).
- Qdrant Standard rates and regions. The $114/mo figure and the $0.078 per GB-hour rate are third-party.
- Weaviate: hybrid search page, activation time for inactive tenants, region list, and the unit on the per-dimension price (assumed monthly).
- Upstash latency figures and whether several indexes per account are allowed.
- OpenSearch Serverless NextGen: OCU price, wake-from-zero time, and tenant limits.
- S3 Vectors: physical-erasure wording, and any latency percentiles. The rates came from worked examples, not a rendered table.
- turbopuffer: cache eviction time, physical-deletion timing, and cold latency below 1M documents. Its per-GB rates came from calculator code in the page's JavaScript, not from prose. The $1 per PB query rate is confirmed only by a secondary source. The June 2026 minimum cut ($64 to $16) is from a pricing tracker.
- Whether turbopuffer's EU clusters keep all processing inside the EU. The regions page lists the regions but says nothing about processing locality.

**Embeddings**
- Any vendor's query-embedding latency. I found no figures; benchmark from the EU deployment.
- Spanish retrieval quality for every model. The aggregator has no Spanish column.
- Titan v2 retrieval quality. It is not on RTEB, and AWS describes it as English-optimised.
- Cohere Embed 5 pricing from a primary source, and Cohere's own EU hosting.
- Voyage EU processing (see recommendation 2).
- Gemini on Vertex EU locations.
- OpenAI's embedding dimension-shortening parameter (the model page did not state dimensions).
- The aggregator's rows are not an official MTEB export; some Voyage rows may be self-reported, and the gemini-embedding-2-preview row looks anomalous.

**Parsers**
- Any independent quality comparison on tables or slides across these tools.
- Mistral OCR 4 pricing, and Mistral's batch discount for OCR.
- Textract EU region availability and EU prices (only US West was shown).
- LlamaParse and Unstructured EU residency.
- Docling's throughput and compute cost on our documents.

**Transcription**
- AWS Transcribe tier table. Only the $0.006 per minute figure from one example was visible.
- Any published diarization accuracy for AssemblyAI, Deepgram or OpenAI, and per-language diarization support.
- Batch turnaround times for every hosted vendor.
- Gemini 3.5 Transcribe diarization.
- WhisperX throughput and GPU price on AWS (my cost line is an assumption).

## Sources

All fetched 2026-10-12.

**Vector databases and Postgres**
- [V1] https://www.pinecone.io/pricing/
- [V2] https://docs.pinecone.io/guides/index-data/indexing-overview
- [V3] https://docs.pinecone.io/guides/manage-data/manage-namespaces
- [V4] https://docs.pinecone.io/guides/index-data/data-modeling
- [V5] https://docs.pinecone.io/guides/get-started/database-architecture
- [T1] https://turbopuffer.com/pricing
- [T2] calculator constants in the JavaScript bundle served by [T1] (`/_next/static/chunks/7907-d3a6efa281e9348f.js`)
- [T3] https://turbopuffer.com/docs/limits
- [T4] https://turbopuffer.com/docs/regions
- [T5] https://turbopuffer.com/docs/architecture
- [T6] https://turbopuffer.com/docs/hybrid
- [T7] https://turbopuffer.com/docs/fts
- [T8] https://turbopuffer.com/docs/delete-namespace
- [T9] secondary: https://usagepricing.com/blueprint/turbopuffer
- [Q1] https://qdrant.tech/pricing/
- [Q2] https://qdrant.tech/documentation/cloud/create-cluster/
- [Q3] https://qdrant.tech/documentation/guides/multiple-partitions/
- [Q4] secondary: https://leanopstech.com/blog/qdrant-cloud-pricing-2026/
- [W1] https://weaviate.io/pricing
- [W2] https://docs.weaviate.io/weaviate/manage-collections/multi-tenancy
- [W3] https://docs.weaviate.io/weaviate/concepts/data
- [U1] https://upstash.com/pricing/vector
- [U2] https://upstash.com/docs/vector/features/namespaces
- [U3] https://upstash.com/docs/vector/features/hybridindexes
- [S1] https://aws.amazon.com/s3/pricing/
- [S2] https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-limitations.html
- [S3] https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-regions-quotas.html
- [S4] https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors.html
- [S5] https://aws.amazon.com/s3/features/vectors/
- [O1] https://aws.amazon.com/opensearch-service/pricing/
- [O2] https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-vector-search.html
- [O3] https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-overview.html
- [O4] secondary: https://coralogix.com/guides/opensearch/opensearch-pricing/ and https://dev.classmethod.jp/en/articles/20260531-amazon-opensearch-service-nxgn-ga/
- [G1] https://github.com/pgvector/pgvector
- [G2] https://aws.amazon.com/rds/aurora/pricing/
- [npm] `npm view` against the public registry for each SDK, run 2026-10-12

**Embeddings**
- [E1] https://developers.openai.com/api/docs/pricing
- [E2] https://developers.openai.com/api/docs/models/text-embedding-3-large
- [E3] https://developers.openai.com/api/docs/guides/your-data
- [E4] https://docs.voyageai.com/docs/pricing
- [E5] https://docs.voyageai.com/docs/embeddings
- [E6] https://docs.voyageai.com/docs/rate-limits
- [E7] https://docs.voyageai.com/docs/faq
- [E8] https://blog.voyageai.com/2026/01/15/voyage-4/ (dated 2026-01-15; vendor claim)
- [E9] https://docs.cohere.com/docs/cohere-embed
- [E10] https://docs.cohere.com/docs/rate-limits
- [E11] https://cohere.com/pricing
- [E12] secondary: https://www.eesel.ai/blog/cohere-embed-5-pricing and https://datanorth.ai/news/cohere-releases-embed-5-pro-and-embed-5-fast
- [E13] https://ai.google.dev/gemini-api/docs/pricing
- [E14] https://ai.google.dev/gemini-api/docs/embeddings
- [E15] https://ai.google.dev/gemini-api/docs/rate-limits
- [E16] https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html
- [E17] https://aws.amazon.com/blogs/machine-learning/get-started-with-amazon-titan-text-embeddings-v2-a-new-state-of-the-art-embeddings-model-on-amazon-bedrock/ (price taken from a search snippet of this blog)
- [E18] https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html
- [E19] https://huggingface.co/BAAI/bge-m3
- [E20] secondary: https://benchmarklist.com/benchmarks/rteb/ (rows sampled 2026-05-06)
- [E21] https://huggingface.co/blog/rteb (2025-10-01)
- [E22] https://arxiv.org/abs/2502.13595
- [E23] secondary: https://docs.aws.eu/bedrock/latest/userguide/model-card-cohere-embed-v4.html
- [E24] secondary: https://mongodb.com/company/blog/product-release-announcements/europe-data-residency-for-atlas-embedding-reranking

**Parsers**
- [P1] https://www.llamaindex.ai/pricing
- [P2] https://developers.llamaindex.ai/python/cloud/general/pricing/
- [P3] https://www.llamaindex.ai/pricing/europe
- [P4] https://unstructured.io/pricing
- [P5] https://docs.unstructured.io/api-reference/partition/overview
- [P6] https://reducto.ai/pricing
- [P7] https://docs.reducto.ai/overview
- [P8] https://docs.mistral.ai/models/ocr-3-25-12
- [P9] https://docs.mistral.ai/capabilities/document_ai/basic_ocr/
- [P10] https://help.mistral.ai/en/articles/347629-where-do-you-store-my-data-and-are-you-gdpr-compliant
- [P11] https://aws.amazon.com/textract/pricing/
- [P12] https://docs.aws.amazon.com/textract/latest/dg/limits-document.html
- [P13] https://docling-project.github.io/docling/
- [P14] secondary: https://arxiv.org/pdf/2606.01393, https://tensorlake.ai/blog/benchmarks, https://tech-insider.org/mistral-ocr-4-launch-2026/

**Transcription**
- [A1] https://www.deepgram.com/pricing
- [A2] https://developers.deepgram.com/docs/models-languages-overview
- [A3] https://www.assemblyai.com/pricing
- [A4] https://www.assemblyai.com/docs/speech-to-text/pre-recorded-audio/supported-languages
- [A5] https://www.assemblyai.com/docs/speech-to-text/speaker-diarization
- [A6] https://aws.amazon.com/transcribe/pricing/
- [A7] https://docs.aws.amazon.com/transcribe/latest/dg/diarization.html
- [A8] https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html
- [A9] https://docs.aws.amazon.com/general/latest/gr/transcribe.html
- [A10] https://developers.openai.com/api/docs/guides/speech-to-text
- [A12] https://github.com/m-bain/whisperX
- [A13] https://huggingface.co/pyannote/speaker-diarization-community-1

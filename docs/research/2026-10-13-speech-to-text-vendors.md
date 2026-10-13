# Closeline speech-to-text vendors for batch call transcription: research report

Prices and limits were read on 2026-10-13 unless noted. Source keys in square brackets, like [D1], are listed with their URLs at the end. Anything marked "(unverified)" came from memory, an inference, or a single secondary source. Anything marked "(secondary)" came from a third-party site. Anything marked "(vendor claim)" is the vendor's own number.

Page text came through a summarising fetch tool, not raw HTML, so a number may have been mis-summarised. I did not see instructions aimed at AI agents in any result, and I would have ignored them.

The job: Organizations upload past sales calls (two or more speakers, 10 to 90 minutes, English first). We transcribe them with speaker turns and word timestamps, then index them. This is batch work. Phase 2 live calls need streaming, so each vendor's streaming offer is noted, but it does not decide this report.

## 1. Recommendation

**Use AssemblyAI Universal-3.5 Pro with standard diarization, on the EU endpoint where the Organization needs it. Cost: $0.23 per audio hour.**

- It is $0.21 plus $0.02 for diarization. The EU endpoint costs the same as the US one [A1].
- It has the best diarization number in the only cross-vendor test I found. That test is AssemblyAI's own, so treat it as a vendor claim [A5].
- It is not the cheapest. Deepgram on the Growth plan is about $0.216 per hour with diarization included. The gap is about $1,400 a month at 100,000 hours. I judge the accuracy lead worth that, but nothing independent proves it. Run the bake-off in section 6 before signing a commitment.

**Runner-up: Deepgram Nova-3 monolingual.** It is $0.258 per hour pay-as-you-go and $0.216 on Growth (from $4,000 a year). Diarization is included for pre-recorded audio. It has an EU endpoint, SOC 2 Type 2, and a 2 GB file limit [D1][D2]. It is the safer pick if cost matters more than the accuracy gap once we measure it. It also serves phase 2 streaming.

**What would change the choice:**

- Our own bake-off on 20 to 30 real calls shows Deepgram within about 2 points on speaker-attributed word error rate. Then switch to Deepgram for cost.
- Volume passes roughly 100,000 hours a month for a sustained period. Then price a self-hosted GPU pipeline and ask AssemblyAI and Deepgram for committed-volume quotes (section 5).
- An Organization needs audio to stay in our AWS account. Then self-host, or use Amazon Transcribe at much higher cost.
- ElevenLabs confirms EU processing in writing. At $0.22 per hour with diarization included it would then compete on cost and accuracy [E1][E4].
- Google confirms dynamic-batch Chirp 3 at about $0.18 per hour with working diarization for our languages. Then it is the cheapest managed option (unverified, section 3).

## 2. Comparison table

All prices are USD per audio hour for batch (pre-recorded) audio, English.

| Vendor and model | Base price | Diarization | Word timestamps | Languages | Max file | Async shape | EU region | Retention and training | Compliance | Streaming for phase 2 |
|---|---|---|---|---|---|---|---|---|---|---|
| **AssemblyAI** Universal-3.5 Pro | $0.21; Universal-2 $0.15 [A1] | +$0.02 standard, +$0.065 experimental [A1] | Yes (unverified on the pricing page; standard in their API) | 99 languages on one price [A4] | Not found (unverified) | Submit job, then webhook or poll; accepts a URL | Yes, `api.eu.assemblyai.com`, same price [A1] | Async data kept until deleted or a TTL (minimum 1 hour); delete endpoint exists; removal can lag hours to days. Training opt-out exists [A2] | SOC 2 Type 1 and 2 [A2]. DPA, ISO and HIPAA unverified | Yes. Streaming diarization +$0.12 [A1] |
| **Deepgram** Nova-3 monolingual | $0.258 PAYG ($0.0043/min); $0.216 Growth [D1] | Included, no charge for pre-recorded [D1] | Yes (unverified on the pricing page; standard) | Multilingual $0.312 PAYG, $0.258 Growth [D1] | 2 GB (secondary reading of Deepgram docs) [D3] | Callback URL, or a sync request that returns 504 after 10 minutes [D3] | Yes, `api.eu.deepgram.com` [D2] | Retention periods and training default not on the page I read; there is a `mip_opt_out` parameter [D2]. Ask in writing | SOC 2 Type 1 and 2 [D2]. DPA exists; general DPA unverified | Yes. Nova-3 $0.0077/min list; diarization $0.002/min extra [D1][D4] |
| **OpenAI** gpt-4o-transcribe-diarize | About $0.36 ($0.006/min estimate; token-billed) [O1] | In the model | Not confirmed. Segment times yes; word times unverified | Many; diarize model language list unverified | 25 MB typical API limit (unverified), so 10 to 90 minute calls need chunking | Synchronous request; no native job or webhook for audio files (unverified) | Unverified | Unverified | Unverified | Realtime API exists; diarization in streaming unverified |
| **Amazon Transcribe** | $1.44 first 250,000 min/month; tiers down to $0.47 (secondary) [AW1][AW2] | Included [AW1] | Yes | 100+ (unverified) | 4 hours or 2 GB (secondary) [AW3] | Start job from an S3 URI; EventBridge; 100 concurrent jobs by default, queue up to 10,000 [AW3] | Yes, many AWS regions, runs in our account | Output to our S3; AWS data terms | SOC 2, ISO, HIPAA, GDPR DPA via AWS (unverified in detail) | Yes, streaming at the same per-minute rate (secondary) [AW2] |
| **Google Cloud STT V2** Chirp 3 | Standard about $0.96 ($0.016/min); dynamic batch about $0.18 ($0.003/min) (secondary, conflicting: one source $0.004) [G1] | Batch only, limited locales; docs inconsistent [G1] | Yes | 100+ for Chirp 3 | Batch quota allows over 1 hour (secondary) | Batch recognize from a GCS URI, long-running operation | Yes, regional | Data logging opt-in model; details unverified | Google Cloud standard | Yes, streaming |
| **ElevenLabs** Scribe v2 | $0.22 [E1] | Included, up to 32 speakers [E4] | Yes | 90+ [E1] | 3 GB and 10 hours (secondary) [E2] | Webhook option makes the call asynchronous [E2] | Not confirmed; one secondary source says US only unless Enterprise [E3] | Zero Retention Mode listed for Scribe v2 Medical; general policy unverified [E1] | SOC 2 and GDPR claimed (unverified); HIPAA on Medical [E1] | Scribe v2 Realtime $0.39, no streaming diarization [E1][E4] |
| **Speechmatics** Melia 1 | $0.24; Enhanced $0.75; Standard $0.45; Oak 1 $0.30. Opt-in training discount of 33% [S1] | Listed as "Included for free" for pre-recorded audio [S1]; not stated that the rate covers it | Yes | Melia 1 multilingual; per-language support unverified | Under 1 GB in the request body; larger by URL (older docs) [S2] | Job submit, poll or notify | Yes: EU1, US1, AU1 [S3] | 7 days then deleted, or delete sooner (older docs); current rules unconfirmed [S2] | SOC 2 not found (unverified) | Yes. A usage tracker (secondary) says real-time enhanced was cut in July 2026 [S4] |
| **Gladia** Solaria-3 (newer entrant) | About $0.61 Starter; Growth near $0.20 (secondary, vendor blogs) [N1] | Included (vendor claim) | Yes | 100+ (vendor claim) | Unverified | Async job with webhook | Unverified | Unverified | Unverified | Yes, $0.75 real-time (secondary) |
| **Self-host** Whisper large-v3 with WhisperX and pyannote | See section 5 | Via pyannote | Yes, aligned by wav2vec2 | 99 | Ours to set | Ours to build | Any AWS region we run in | Audio never leaves our account | Our own SOC 2 scope | Not realistic for live use; a different stack |

Mistral Voxtral Transcribe and Cohere were in my brief as possible newer entrants. I found no pricing or diarization details for Voxtral in results, so it is unassessed.

### Accuracy figures

Nobody published an independent, cross-vendor test of diarized two-speaker sales-call audio. These are all I found:

- **AssemblyAI's own async speaker-attributed error rate (cpWER):** Universal-3.5 Pro 35.21%, Deepgram 43.21%, Speechmatics 46.11%, Google 57.14%. AssemblyAI's own second table gives different numbers for the same models (Universal-3.5 Pro 30.17%, Deepgram Nova-3 37.92%, Scribe v2 35.26%). Both tables are vendor claims and they disagree with each other [A5].
- **AssemblyAI's own async word error rate:** Universal-3.5 Pro 7.69%, Scribe v2 8.77%, Nova-3 multilingual 12.22%. Vendor claim [A5].
- **Deepgram's own claim:** Nova-3 at 5.26% WER on its own real-world set. Vendor claim [D4].
- **Independent context:** an analysis of three commercial systems reported 16.5 to 19.2% WER on real contact-centre calls, and 10.2 to 11.6% on Switchboard. Two careful human transcribers disagree by 4.1 to 4.5% on telephone speech, so small gaps between vendors are inside the noise [K1] (secondary).
- Whisper large-v3 and pyannote figures on our kind of audio: none found.

## 3. Notes by vendor

**AssemblyAI.** Priced per audio hour, billed on audio submitted. The pricing page shows no volume tiers, only enterprise concurrency [A1]. Stereo files bill per channel in the earlier ingestion report, so send mono or merge channels (unverified here). Per-language diarization support and the maximum file length need confirming.

**Deepgram.** Whisper Large is also offered at $0.0048/min [D1]. Flux is streaming only [D1]. The Growth plan saves up to 20% and needs a commitment from $4,000 a year [D1]. For long calls use the callback, not a held connection [D3].

**OpenAI.** The pricing page gave an estimate of $0.006 per minute for the diarize model, but secondary sources say it bills tokens ($2.50 per million in, $10 per million out), so real cost per hour could differ [O1][O2]. It fits our async-job shape poorly. I would not choose it for batch.

**Amazon Transcribe.** Easiest to run: the file stays in S3, no egress, and EU regions are normal. It is the most expensive by far. The AWS page itself showed a $0.006 per minute batch example that does not match the $0.024 tier-one rate I found on third-party sites, so I could not confirm the tier table [AW1][AW2].

**Google Cloud.** Cheapest managed rate on paper, but I could not read the official price table (the fetch returned no content). The dynamic-batch rate, the batch diarization coverage, and the Chirp 3 limits are all unverified [G1].

**ElevenLabs.** Competitive price with diarization included, and one secondary source places Scribe v2 close to the leaders [A5]. The blocker is EU processing, which I could not confirm [E3]. Keyterm prompting costs $0.05 extra per hour [E1].

**Speechmatics.** The official page shows Melia 1 at $0.24, which conflicts with a usage tracker's $0.129 and $0.40 figures. I used the official page [S1]. Its pay-as-you-go tier has no volume discount; subscriptions give up to 25% off. It is strong on EU hosting but weaker on measured diarization in the one test I have [A5].

**Gladia.** Cheapest at the Growth rate if the $0.20 holds, but every figure is secondary or a vendor blog. Worth one quote request, not a decision.

## 4. Worked monthly cost

Assumes all calls are English, mono, with diarization, and billed on audio hours with no minimum. Rounded to the dollar. Where a vendor has no published volume tier, the list rate is used at every volume.

| Option | Hourly rate used | 1,000 h | 10,000 h | 100,000 h |
|---|---|---|---|---|
| **AssemblyAI** U-3.5 Pro + diarization | $0.23 | **$230** | **$2,300** | **$23,000** |
| AssemblyAI Universal-2 + diarization | $0.17 | $170 | $1,700 | $17,000 |
| **Deepgram** Nova-3, pay-as-you-go | $0.258 | **$258** | **$2,580** | **$25,800** |
| Deepgram Nova-3, Growth | $0.216 | $216 | $2,160 | $21,600 |
| ElevenLabs Scribe v2 | $0.22 | $220 | $2,200 | $22,000 |
| Speechmatics Melia 1 | $0.24 | $240 | $2,400 | $24,000 |
| Speechmatics Enhanced | $0.75 | $750 | $7,500 | $75,000 |
| OpenAI gpt-4o-transcribe-diarize (estimate) | $0.36 | $360 | $3,600 | $36,000 |
| Google Chirp 3 dynamic batch (unverified) | $0.18 | $180 | $1,800 | $18,000 |
| Amazon Transcribe (tiers from secondary sources) | $1.44 falling to $0.47 | $1,440 | $11,250 | $65,850 |
| Gladia Starter (secondary) | $0.61 | $610 | $6,100 | $61,000 |
| Self-hosted GPU (section 5) | $0.08 to $0.25 compute | $80 to $250 plus fixed costs | $800 to $2,500 plus fixed costs | $8,000 to $25,000 plus fixed costs |

How the Amazon figures were worked: 1,000 hours is 60,000 minutes at $0.024. 10,000 hours is 600,000 minutes: 250,000 at $0.024 plus 350,000 at $0.015. 100,000 hours is 6 million minutes: 250,000 at $0.024, 750,000 at $0.015, 4 million at $0.0102 and 1 million at $0.0078.

Read the table this way: at 100,000 hours a month, the managed options that matter span $21,600 to $25,800. The accuracy choice moves the bill by a few thousand dollars. Re-transcribing a bad batch costs more.

## 5. Self-hosting on AWS

**Stack:** faster-whisper (Whisper large-v3, quantised) for transcription, wav2vec2 alignment for word times, pyannote for speakers (the WhisperX pattern). NVIDIA Parakeet and Canary do not diarize on their own; you pair them with Sortformer and merge the timestamps yourself. One forum comment says the Sortformer v1 licence is non-commercial (unverified) [W3].

**GPU prices on AWS, us-east-1 on-demand (secondary, July 2026):** g6.xlarge (one L4) about $0.80 per hour, spot low about $0.35. g6e.xlarge (one L40S) about $1.86 per hour, spot low about $0.87 [W1].

**Throughput.** I found no AWS-specific benchmark. Community numbers for large-v3 run from about 12x real time on an RTX 3090 to about 19x on an A5000 [W2], and the same sources disagree on memory (5 to 6 GB versus 16 to 20 GB) [W2]. The estimate below is mine, not measured:

- Assume 15x to 40x real time for the full pipeline on an L40S once diarization and alignment are included.
- That is $1.86 divided by 15 to 40, so $0.05 to $0.12 per audio hour at full use.
- Real queues are not full. At 40 to 50% utilisation it is $0.10 to $0.25 per audio hour.
- Spot instances on g6 could cut that by half, with interruption handling.

**Fixed costs and burden (my estimate):**

- GPU autoscaling from the queue to zero, spot interruption handling, and a model-weight and container pipeline.
- A diarization and word-alignment merge that we own. Quality on overlapping speech is the usual weak spot.
- Whisper can hallucinate text over silence. It needs voice-activity filtering and a regression set.
- A monitoring and eval setup, plus an on-call burden for a GPU service. Plan on roughly half to one engineer ongoing. That is $8,000 to $15,000 a month in people cost.
- Languages other than English each need their own evaluation. The managed vendors give this to us.

**Break-even.** Managed cost at $0.23 per hour is $23,000 at 100,000 hours. Self-hosted compute is $8,000 to $25,000 plus $8,000 to $15,000 of people. The two roughly meet near 100,000 hours a month. Below that, managed wins on cost and effort. Above about 300,000 hours a month self-hosting starts to win clearly (my estimate). It stays the escalation path, not the starting point.

**Data handling is its one clear win:** audio never leaves our AWS account, and deletion is ours to prove.

## 6. What to do next

1. Contact AssemblyAI and Deepgram for written answers on: training on customer audio (default and opt-out), deletion timing, EU processing scope, DPA, SOC 2 Type 2 report, maximum file length, and committed-volume pricing.
2. Run a bake-off before committing: 20 to 30 real two-speaker sales calls, hand-corrected, scored for word error rate and speaker-attributed word error rate. Cover AssemblyAI, Deepgram, ElevenLabs and Speechmatics. Include at least some noisy telephony. Check the stereo-per-channel billing rule on a real file.
3. Wrap the vendor behind a small port in the transcription service, with a memory adapter for tests, so a switch is a new adapter and not a rewrite. Per COMMON.md, a port is justified once there are two real implementations, and here there will be.
4. Use presigned S3 URLs as input, a webhook with a polling fallback, a job idempotency key per upload, and a timeout and jittered retry on every vendor call.
5. Treat the transcript and any audio as untrusted data, and never log bodies.

## Sources

Accessed 2026-10-13.

- [A1] AssemblyAI pricing: https://www.assemblyai.com/pricing
- [A2] AssemblyAI data retention and model training: https://assemblyai.com/docs/data-retention-and-model-training
- [A4] AssemblyAI, 99 languages: https://www.assemblyai.com/blog/99-languages
- [A5] AssemblyAI, how accurate is speech-to-text in 2026 (vendor benchmark): https://www.assemblyai.com/blog/how-accurate-speech-to-text
- [D1] Deepgram pricing: https://deepgram.com/pricing
- [D2] Deepgram data privacy and compliance: https://developers.deepgram.com/docs/data-privacy-compliance
- [D3] Deepgram pre-recorded audio docs (file size, timeouts): https://developers.deepgram.com/docs/pre-recorded-audio
- [D4] Deepgram Nova-3 pricing summary (secondary): https://convertaudiototext.com/blog/deepgram-nova-3-explained
- [O1] OpenAI API pricing: https://developers.openai.com/api/docs/pricing
- [O2] gpt-4o-transcribe-diarize token pricing (secondary): https://gate.ai/blog/gpt-4o-transcribe-diarize-openai-specs-pricing-api-use-cases
- [AW1] Amazon Transcribe pricing: https://aws.amazon.com/transcribe/pricing/
- [AW2] Amazon Transcribe tier rates (secondary): https://brasstranscripts.com/blog/amazon-transcribe-pricing-2026-cost-calculator-guide
- [AW3] Amazon Transcribe limits (secondary): https://awsglossary.org/terms/transcribe
- [G1] Google Chirp 3 and Speech-to-Text pricing (secondary): https://opentranscription.io/blog/google-cloud-chirp-3-capabilities-architecture-costs-and-com.html ; official page, which I could not read: https://cloud.google.com/speech-to-text/pricing
- [E1] ElevenLabs API pricing: https://elevenlabs.io/pricing/api
- [E2] ElevenLabs speech-to-text API reference: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
- [E3] Recall.ai note on ElevenLabs data residency (secondary): https://docs.recall.ai/docs/elevenlabs
- [E4] ElevenLabs Scribe v2 summary (secondary): https://www.therundown.ai/tools/scribe-v2
- [S1] Speechmatics pricing: https://www.speechmatics.com/pricing
- [S2] Speechmatics batch limits: https://docs.speechmatics.com/speech-to-text/batch/limits
- [S3] Speechmatics regions: https://docs.speechmatics.com/administration/regions
- [S4] Speechmatics price change tracker (secondary): https://www.usagepricing.com/blueprint/activity/speechmatics-2026-07-06-realtime-stt-price-cut
- [N1] Gladia pricing summary (secondary): https://www.gladia.io/blog/assemblyai-pricing
- [K1] Kili, ASR models and word error rate (secondary): https://kili-technology.com/blog/asr-models-guide-word-error-rate-benchmarks-and-failure-modes-2026
- [W1] EC2 g6 and g6e prices (secondary): https://compute.doit.com/spot/us-east-1/g6e.xlarge
- [W2] Whisper large-v3 GPU benchmarks (secondary): https://www.runpod.io/articles/guides/best-gpu-for-whisper
- [W3] NVIDIA Parakeet diarization discussion: https://github.com/NVIDIA-NeMo/Speech/discussions/14842

## What I could not verify

- Official Google Speech-to-Text price table, batch diarization coverage and Chirp 3 limits.
- The Amazon Transcribe tier table and its file limits from AWS itself.
- OpenAI's real per-hour billing, file limit, retention policy and EU options.
- ElevenLabs EU residency and its general retention and training policy.
- Deepgram and Speechmatics training and retention defaults; Speechmatics SOC 2 status.
- AssemblyAI maximum file length, DPA and word-timestamp details on the pricing page.
- Any independent diarization benchmark on sales-call audio.
- AWS GPU throughput for the self-hosted stack. The self-host cost range is my estimate.
- Mistral Voxtral Transcribe pricing and diarization.

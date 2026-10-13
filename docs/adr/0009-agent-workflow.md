# ADR 0009 — Agent workflow: hub-owned setup, one lead, bounded workers

**Status:** Accepted
**Date:** 2026-10-12

## Context

Closeline is built largely by AI agents across many repos. The owner wants it built quickly, in parallel where possible, without exhausting session limits, and to a production standard. tula-auth's loop (verify, independent review, test-first fixes, a Stop gate) is the model, but its single standards document is several thousand lines read in full every session, and payhub's per-repo copies of workflow files have drifted.

## Decision

- **Hub-owned setup.** This repo holds the one canonical set of standards, hooks, skills, the reviewer agent and reusable CI. A sync script copies it into every other repo, and CI fails on drift.
- **Thin repos.** Each repo's own `AGENTS.md` is short (about 200 lines at most). Detail lives in path-scoped rules and decision records that load only when relevant.
- **One lead, bounded workers.** A lead session on the most capable model plans, briefs, reviews and merges. Each ticket goes to a worker on a cheaper model, in one repo, with a brief that names the files and the contract version. At most four workers run at once, and no two share a repo area. Searches use the cheapest model.
- **Performance gate.** Every ticket follows fixed rules checked in review: no unbounded queries, pagination on every list, idempotent retries, a timeout on every outbound call, and tenant-isolation tests. A ticket on a hot path (live audio, Playbook search, queue consumers, send scheduling) states its expected complexity and ships a benchmark with a budget enforced by `verify`. Every service keeps a benchmark suite that CI runs and tracks over time. Each phase ends with a load test against that phase's target.

## Consequences

- A change to the shared setup is made once in the hub and synced; editing a synced file in a service repo fails CI.
- The four-worker limit trades some speed for staying within session limits and for fewer merge conflicts.
- Hot paths must be named in each service's `AGENTS.md`, or the gate has nothing to bind to.

# ADR 0001 — Region per Organization

**Status:** Accepted
**Date:** 2026-10-12

## Context

Closeline sells to companies in the US and the EU. It stores call recordings, transcripts, Voice Profiles and Prospect contact details, and EU buyers expect that data to stay in the EU. The design must also grow to very large numbers of simultaneous calls without a redesign.

## Decision

Every Organization is created in exactly one Region (US or EU) and its data never leaves it. Each Region is a full, independent deployment: its own database, queues, services and its own auth service. Nothing is shared between Regions at runtime.

## Considered options

- **A single US deployment**, with EU transfers covered by contract terms. Cheapest, but many EU buyers refuse it and call latency from Europe is worse.
- **A single global sign-in service** in front of regional data. One account would work everywhere, but EU Reps' identities would sit in one location and that service would be a single point of failure for every Region.

## Consequences

- A person who works in both a US and an EU Organization has two separate accounts.
- An Organization cannot be moved between Regions without a migration project.
- Every vendor behind a provider interface must offer processing in both Regions, or be swapped per Region.
- Capacity grows by adding deployments, which is also how the design avoids a ceiling on concurrent calls.

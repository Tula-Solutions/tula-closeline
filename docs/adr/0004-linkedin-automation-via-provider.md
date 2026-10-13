# ADR 0004 — Automated LinkedIn outreach through a third-party provider

**Status:** Accepted
**Date:** 2026-10-12

## Context

Competing products offer automated LinkedIn steps inside outbound campaigns. LinkedIn's User Agreement prohibits automated activity on its site, and the penalty, restriction or closure of the account, falls on the Organization's own Reps.

## Decision

The Outbound Agent sends LinkedIn connection requests and messages automatically, through a third-party LinkedIn messaging provider behind closeline's own interface. Each Rep connects their own account. Before the channel is enabled, an Admin accepts the account-restriction risk in writing, and closeline enforces low daily limits per connected account.

## Considered options

- **Draft-only, with a Rep sending by hand.** Stays within LinkedIn's terms, but drops a channel customers expect.
- **Closeline's own browser automation.** No vendor fee, but a permanent maintenance burden, and the breach of terms would be closeline's directly.

## Consequences

- This is a known breach of LinkedIn's terms, accepted as a business risk. It is recorded here so nobody mistakes it for an oversight.
- The provider can be cut off by LinkedIn at any time; the interface must allow the channel to be disabled without affecting campaigns on other channels.
- The written risk acceptance and the per-account limits are product requirements, not optional settings.

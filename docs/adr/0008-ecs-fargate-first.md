# ADR 0008 — ECS on Fargate first, EKS when it pays

**Status:** Accepted
**Date:** 2026-10-12

## Context

Closeline runs as containers on AWS in two Regions and should cost as little as possible while traffic is small. Payhub runs on Kubernetes (EKS) with Helm, which carries a fixed control-plane fee per cluster and regular upgrade and node-management work.

## Decision

Services run on ECS with Fargate. Each service scales on its own load, and there is no cluster to operate and no fixed fee per Region.

Move to EKS when either is true:

- monthly compute spend is high enough that packing containers onto cheaper or spot servers saves more than a cluster costs to run;
- closeline starts self-hosting models on GPUs, which Fargate does not offer.

## Consequences

- Compute is dearer per container than on self-managed servers; this is accepted while volume is low.
- Deployment tooling differs from payhub's Helm charts.
- Services must stay plain containers with no ECS-specific code, so the later move is an infrastructure change only.

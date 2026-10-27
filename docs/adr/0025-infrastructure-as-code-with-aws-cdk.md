# ADR 0025 — Infrastructure as code with the AWS CDK in TypeScript

**Status:** Accepted
**Date:** 2026-10-23
**Builds on:** ADR 0001, ADR 0006, ADR 0008

## Context

Plan step 1.18 (#19) leaves the infrastructure-as-code tool open. Tickets that need AWS resources are waiting on it, for example #344 (core's jobs queue). Every other Closeline repo is TypeScript on Bun, formatted by Biome and tested with `bun:test`. Closeline runs only on AWS, with one full deployment per Region (ADR 0001) on ECS Fargate (ADR 0008).

The options considered:

- **Terraform or OpenTofu.** These are the most common and work with any cloud. They bring a second language (HCL), their own test tooling and a state backend to run.
- **AWS CDK in TypeScript.** It uses the same language, linter and test runner as the rest of Closeline, and CloudFormation holds the state. It works only on AWS.
- **Pulumi or SST.** Both are TypeScript. Pulumi needs a state service or a self-managed backend. SST is tuned for serverless apps rather than ECS services.

## Decision

`tula-closeline-infra` uses the **AWS CDK v2 in TypeScript**, run with Bun.

- **One app and one stage per Region.** Each Region gets the same set of stacks, built from a typed Region config (account, Region, environment `dev|staging|prod`). No resource name or ARN is hard-coded outside that config.
- **Stacks split by lifecycle:**
  - network;
  - data (Postgres, object storage);
  - messaging (queues and their dead-letter queues);
  - one service stack per Closeline service (ECS service, task role, its queue grants, its environment, its alarms);
  - edge (load balancer, path-based routing).

  A service stack takes the resources it uses as typed props. It does not look them up by name.
- **Tests:** `bun:test` with `aws-cdk-lib/assertions`. Each stack is synthesised and its template asserted on: the resources it must have, the IAM grants it must and must not hold, and alarms on every dead-letter queue. `bun run verify` synthesises every stage, so a stack that does not synthesise fails the gate.
- **Secrets** live in Secrets Manager and reach tasks as ECS secrets. They are never plain environment values and never appear in a template or in source.
- **Deploying:**
  - Only CI deploys, through a GitHub Actions role assumed by OIDC. People and agent sessions never deploy from a laptop.
  - Until the OIDC role and the CDK bootstrap exist in an account, the deploy workflow runs only on manual dispatch.
  - A deploy runs `cdk diff` first and records it in the job log.

## Consequences

- One language, linter and test runner across every repo, and agents work in infra as they do elsewhere.
- Closeline is tied to AWS for infrastructure. This is accepted; ADR 0001 already makes AWS the only cloud.
- CloudFormation limits apply: 500 resources per stack, and some changes replace a resource. Stacks stay split by lifecycle, and the data stack's resources keep a retain policy so that a stack change never deletes a database or bucket.
- An owner must create the OIDC deploy role and run `cdk bootstrap` once per account and Region. This is a manual step, listed in the infra README.

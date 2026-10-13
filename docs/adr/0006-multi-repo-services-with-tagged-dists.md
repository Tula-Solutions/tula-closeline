# ADR 0006 — One repo per service, shared code as tagged dists

**Status:** Accepted
**Date:** 2026-10-12

## Context

Closeline's parts have very different load profiles: live audio, bulk outbound sending, Playbook search and ordinary dashboard traffic. The owner wants each to scale and deploy on its own, following the multi-repo split used in payhub. Payhub's sharing mechanism (a committed `dist/` folder consumed over a bare git URL, built by a pre-commit hook, pinned only by the lockfile) has a recorded history of forgotten or stale dists and silent downgrades. Payhub's services are layered, not hexagonal; the hexagonal layout comes from tula-auth.

## Decision

Closeline is a set of repos named `tula-closeline-*`, with this repo as the hub for documentation, plans and the shared workflow setup.

- **Shared libraries:** `-contract` (API types and schemas), `-db` (migrations and typed schema), `-kit` (runtime helpers such as token verification, the queue port and logging).
- **Services:** `-auth`, `-core`, `-playbook`, `-voice`, `-outbound`.
- **Other:** `-portal` (web app), `-infra` (AWS).

Each service uses tula-auth's hybrid hexagonal layout: modules of router, service and schema, with ports, adapters and a single composition root.

Shared libraries are consumed as a committed `dist/` over a git URL, as in payhub, with two changes: every consumer pins a version tag, and the library's CI rebuilds `dist/` and fails if it differs from what was committed.

Repos are created when the phase that needs them starts.

## Considered options

- **A monorepo**, as tula-auth uses. One pull request per change and no versioning, but it does not match the owner's working pattern and loads more into every agent session.
- **Payhub's mechanism unchanged.** Rejected for the failures recorded in payhub's own history.
- **A private package registry.** Normal version ranges, but adds registry authentication to every install and build.

## Consequences

- A change that crosses contract, database and a service is several pull requests that must land in order: shared library, tag, then consumers.
- Contract and database work lands first in each phase, so service repos can then be built in parallel against a fixed version.
- Each library needs a release step that tags a version; consumers upgrade deliberately by changing the tag.
- The portal imports only `-contract`, never server code.

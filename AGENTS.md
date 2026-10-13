# tula-closeline (hub)

The hub for Closeline. It holds no product code. It owns:

- `GLOSSARY.md` — the domain language, synced into every repo.
- `docs/adr/` — every decision record. Other repos have none.
- `docs/plans/phase-N.md` — one plan per phase, each turned into a parent issue with tickets.
- `shared/` — the canonical workflow setup (standards, hooks, skills, reviewer agent, lint config,
  PR template), mirrored into every repo by `scripts/sync-shared.sh`.
- `templates/` — what a new repo starts from (`scripts/new-repo.sh`).
- `.github/workflows/verify.yml` — the one CI definition every repo calls.
- All issues, for every repo.

Common standards for all repos, this one included, are in `.claude/COMMON.md`.

## Commands

| Command | Use |
| --- | --- |
| `bun run verify` | Biome, typecheck, hook tests, and that the hub's own synced copies match `shared/` |
| `bun run sync` | copy `shared/` into the hub and every sibling `tula-closeline-*` clone |
| `bun run sync:check` | report drift without copying |
| `scripts/new-repo.sh [--publish] <short> <library\|service\|bare> "<description>"` | create a repo |

## Changing the shared setup

1. Edit the file under `shared/` (never the synced copy at the hub root or in another repo; the
   `protect-files.sh` hook blocks those).
2. `bun run sync`, then `bun run verify` here.
3. Commit the hub, then commit the synced files in each repo (`chore: sync shared setup`).

`biome.json` is the one shared file that is canonical at the hub root, not under `shared/`: Biome
refuses a second root config nested in a project. It is copied unchanged from tula-auth, so its
ignore list still names tula-auth's paths; each repo scopes `biome check` to its source folders in
`package.json` instead.

## Running the loop across repos (lead session)

1. A plan in `docs/plans/` becomes a parent issue here; each step is a sub-issue labelled
   `ready-for-agent` and `repo:<short>`, with blocking edges.
2. Library tickets (`contract`, `db`, `kit`) land and are tagged first. Service tickets name the
   tag they build against.
3. Pick up to four unblocked tickets that do not share a repo area. Give each to a Sonnet worker
   in that repo, on a `feat/…` branch from `origin/develop`, with a brief that names the files,
   the contract version and the acceptance criteria. Searches use the cheapest model.
4. The worker runs `/review-loop` to green. The lead reviews the diff, opens the PR into
   `develop`, and merges with a merge commit once CI is green.
5. After merging a library, tag it and bump the tag in its consumers in the same round.
6. Each phase ends with a load test against that phase's target (ADR 0009).

## Agent skills

### Issue tracker

Issues for every Closeline repo live in this repo's GitHub Issues
(`Tula-Solutions/tula-closeline`), managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels are used as-is: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at this repo's root. See `docs/agents/domain.md`.

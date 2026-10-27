# ADR 0026 — Refresh tokens are random, stored as a hash

**Status:** Accepted (a lead decision).
**Date:** 2026-10-27
**Builds on:** ADR 0005, ADR 0012

## Context

Auth rotates a refresh token on every use and stores only its hash. The token itself is not random:
`deriveToken` (`src/modules/session/service.ts`) makes it an HMAC under `AUTH_MASTER_KEY` of
`session:<sessionId>` for the first token and `parent:<parentId>` for each next one. Derivation lets
auth answer a spent token inside the 10-second reuse grace (`REUSE_GRACE_MS`, a lost response)
with the same next token without keeping that token anywhere.

The cost: anyone holding the master key can compute a session's first refresh token from its
session id, which the client receives and which is not treated as a secret, and every later token
from row ids. A leak of one key becomes a way into every session, with no database access needed.
Found in the repo audit (#440, item 1).

## Decision

**A refresh token is 32 random bytes** (`crypto.getRandomValues`, base64url, the existing prefix).
Auth stores its SHA-256 hash, as today, and looks it up by that hash.

**The reuse grace keeps working by sealing, not deriving.** When a token is rotated, the next token
is also stored encrypted (AES-256-GCM under a key derived from `AUTH_MASTER_KEY` for this purpose
only, the row id as associated data) on the spent token's row. A spent token presented within the
grace gets that token back; after the grace the sealed value is cleared and the token is treated as
reused, as today. So the only reversible copy of a token lives for at most 10 seconds, and reading
it needs both the database and the key.

**Existing sessions are not cut off.** Tokens issued before the change still verify by their hash.
Rotation from them issues a random token, so derived tokens disappear within one idle timeout.

## Considered options

- **Keep derivation and record why.** Rejected: it turns a key leak alone into session takeover.
- **Random tokens and drop the same-token answer in the grace.** Rejected: a client that lost the
  response would be signed out (or would trip reuse detection) on a flaky network.
- **Random tokens and keep the next token in plaintext for the grace.** Rejected: a database read
  alone would yield live tokens.

## Consequences

- `tula-closeline-db` adds a nullable sealed-next-token column to auth's refresh-token table (a new
  migration), then auth replaces `deriveToken` and clears the column when the grace ends. A
  follow-up issue tracks both.
- The session-store suite gains a case for replay within the grace and refusal after it.

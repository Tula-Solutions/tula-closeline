# ADR 0014 — Lockout: known devices are exempt

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0005, ADR 0007, ADR 0011, ADR 0012

## Context

The auth service (ADR 0005, copied from tula-auth) locks sign-in for an address after repeated wrong passwords, and checks the lockout before it verifies the password. Anyone can therefore keep a victim locked out: about 11 wrong passwords for the victim's address, then one every 15 minutes. The weakness is inherited from tula-auth.

The lockout and per-address rate-limit counters are also held in process memory. That multiplies the guessing budget by the number of instances, resets it on every deploy or crash, and breaks the rule that state lives in Postgres, the queue or the cache (hub issue 30, from the round 1 review of auth#1).

## Decision

1. **Lockout stays keyed by address for unknown devices.** An address with too many wrong passwords is locked against devices that have not signed in to it before.
2. **A known device is not locked out by other people's wrong guesses.** A device that has signed in successfully to that account before carries a signed cookie. Sign-in from it is not refused because of lockout counted against the address.
3. **Lockout and rate-limit state lives in Postgres**, not process memory, keyed by a keyed hash of the address (HMAC), never the address itself. Instances share it, so the budget no longer depends on how many run or when they last restarted.
4. **Auth sets the known-device cookie on a successful sign-in and verifies it at sign-in.** Both are done by the lockout work (hub issue 30), not by the browser-session work, and the cookie is separate from the refresh cookie of ADR 0012.

A known device is still limited: a bound on wrong passwords per device or per account always applies, and its size is left to the implementing ticket, as are the format and lifetime of the cookie.

## Considered options

- **Keying lockout on address plus device.** Rejected: an attacker who sends no cookie, or a fresh one each time, gets a fresh budget for every attempt, so the guessing limit stops limiting guessing.
- **Accepting the risk and documenting it.** Rejected: it leaves anyone able to lock a named person out of the product indefinitely at the cost of one request every 15 minutes.

## Consequences

- A person on a device they have used before keeps being able to sign in while someone else guesses at their address. A person on a new device is still locked out by that guessing until it stops.
- A known device that is stolen, or whose cookie is copied, is not slowed by the address lockout. The bound that still applies to it matters for that reason.
- The cookie must be signed, so a device cannot claim to be known by writing its own, and tied to the account it was earned on, so it exempts the device from nothing else.
- Moving the counters to Postgres needs a migration in the `auth` schema in `tula-closeline-db`, and Postgres adapters for auth's lockout and rate-limiter ports. Auth's "one instance only" deployment constraint is removed once they land.
- The state table holds data from before an Organization exists, so it sits outside row-level security and is handled as ADR 0011's pre-Organization tables are in the db library.
- A test with two app instances over one database must show they share one budget: six wrong passwords split across them still lock the sixth.
- Rows expire and are purged in bounded batches, so the table does not grow with the number of addresses ever seen.

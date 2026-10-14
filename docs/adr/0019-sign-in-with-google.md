# ADR 0019 — Sign in with Google: a server-side authorization-code flow run by auth

**Status:** Accepted
**Date:** 2026-10-14
**Builds on:** ADR 0005, ADR 0011, ADR 0012

## Context

Sign-up today asks for an email, a password and an emailed code. People want to start faster and sign in without a password. Google already verifies the email address it reports, so a Google user can skip the emailed code. The sign-in has to fit what is already decided: the auth service issues every token (ADR 0005), every signed-in user has exactly one Organization chosen at sign-up (ADR 0011), and the browser holds only an access token in memory with a refresh cookie that only auth receives (ADR 0012).

## Decision

1. **Auth runs a server-side OpenID Connect authorization-code flow with PKCE (S256), a `state` and a `nonce`.** The portal asks auth to start; auth stores the `state`, `nonce` and code verifier in a single-use attempt with a 10-minute lifetime, bound to a short-lived attempt cookie, and returns the Google URL for the portal to open. Google redirects to a callback on the portal's origin, which the proxy routes to auth (ADR 0012). Auth exchanges the code once with its client secret and verifies the ID token against Google's published keys: RS256 only, issuer, audience, expiry, `nonce`, and `email_verified` true. It requests `openid email profile`, with no offline access. The ID token must also carry `sub` and `email`, and its `exp` and `iat` are checked with 60 s of skew; Google's keys are cached and refetched on an unknown key id. The attempt cookie is `Secure`, `HttpOnly` and host-only, with its `Path` limited to the callback and completion routes. It is `SameSite=Lax`, not `Strict`, because Google's redirect back is a cross-site top-level navigation that a `Strict` cookie would not accompany. The callback is therefore exempt from the `Origin` check of ADR 0012 and relies on the `state` matching the cookie.
2. **The session is the same session.** After a successful callback auth issues it through the same path as password sign-in for the browser client, sets the refresh cookie on the redirect, and the portal refreshes on load. No token appears in a URL or a response body. The checks password sign-in makes (a deleted Organization, no Organization, a banned user, an unavailable membership) apply unchanged.
3. **Accounts are keyed on Google's `sub`, never on the email.**
   - A known `sub` signs in. A later change of the Google email is ignored.
   - A new `sub` whose email matches an existing password account becomes a Linked Google account automatically, only when `email_verified` is true. The password stays valid and the link is recorded as an event. If `email_verified` is false the flow is refused.
   - One Google account links to one user.
4. **The callback makes no Organization decision.** For a new person it creates nothing. It keeps what Google reported (subject, email, name) sealed in the attempt, where it expires with the attempt and is deleted on completion, and sends the person to a step where they name an Organization or accept an Invitation; only then does a separate call create the Organization through the sign-up path of ADR 0011. That call asks core first, bounded at 5 s, with the idempotency key `signup:<attempt id>` and a user id fixed in the attempt, and only afterwards writes the user and the Google identity in one short transaction, so no connection is held across the network call. For an Invitation, the Google email must equal the invited address. The one-Organization-per-user rule and the idempotency key of ADR 0011 apply unchanged.
5. **Google users have no password.** There is no emailed code, because Google verified the email. A Google-only user who wants a password uses the existing reset flow.
6. **The feature is off when its configuration is unset.** The Google client id, client secret and redirect URI are set all together or not at all; a half-set configuration fails at boot. When off, the routes answer `oidc.disabled` and the auth options tell the portal to hide the button. Outside `local`, the redirect URI must be https, on an allowed session origin, at the callback path.
7. **Local development uses a fake provider by default.** `bun run dev` starts a fake OpenID provider when no Google configuration is set, so the whole flow runs and is tested without Google, including bad nonce, audience, issuer, expired and unverified-email tokens. Real Google is opt-in by setting the configuration; the fake provider's issuer can be set in `local` only.
8. **Abuse and leakage limits.** `returnTo` is a same-origin path (starting with `/`, never `//` or `/\`) checked against the portal's route allow-list; it is stored in the attempt and never read from the callback, so the flow cannot be used as an open redirect. The callback and completion routes are rate limited per source and per attempt. Tokens, codes and Authorization headers are never logged. No response reveals whether an email already has a password account.
9. **Every call to Google has a 5 s timeout and at most two jittered retries**, on server errors and network failures only. The code exchange is never retried once Google has answered.

## Considered options

- **A client-side Google Identity Services token** (the page receives an ID token and posts it to auth). Rejected: the token would pass through browser script, and auth could not bind it to its own `state` and `nonce`, so a token for another site or a replayed one is harder to refuse. It also puts Google's script on every sign-in page. The server-side flow keeps the secret and the verification where the other credentials already are.
- **Linking by email without `email_verified`.** Rejected: anyone who can put another person's address on a Google account they control would take over that person's password account. The flag is the only evidence Google gives that the address was proven.
- **A third-party auth service** (a hosted identity provider in front of auth). Rejected: ADR 0005 chose to own the auth service, and a second issuer of identity would split sessions, tokens and the Organization claim across two systems, and add a vendor and a per-user cost to every sign-in, for one provider.

## Consequences

- A Google Workspace address, or a recycled one, can belong to someone other than the person who first had it. An administrator of a Workspace domain can create an account with a verified address, and a company address given to a new hire after a departure verifies as the new person. Auto-link on a verified email therefore trusts the domain's owner and Google's recycling rules. We accept this risk because the other path, an emailed code, trusts the same mailbox; the link is recorded as an event so it can be reviewed, and a password account is never silently replaced.
- An attacker who controls a verified Google address can take over a password account for that address that the real owner never linked. This is the same exposure as the address's password-reset email.
- Sign-up through Google needs core up, like any sign-up (ADR 0011).
- Auth gains a dependency on Google's availability for this path only. A Google outage answers `oidc.provider_unavailable` with a retry hint; password sign-in is unaffected.
- The redirect URIs must be registered with Google for each environment, and the local tunnel origin must be added by hand when real Google is used locally.
- No new table is expected: the identity table already lists `google` and is unique on the provider and subject. The attempt table may need a new kind; the db ticket checks.
- The contract gains a minor release: the start and complete requests, a providers flag in the auth options, and the codes `oidc.disabled`, `oidc.state_invalid`, `oidc.email_unverified`, `oidc.provider_unavailable` and `oidc.invitation_mismatch`.
- Adding another provider later means a second adapter behind the same port and its own subject key, not a new flow.
- Auth moves further from tula-auth, the code it was copied from (ADR 0005).

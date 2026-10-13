# ADR 0012 — Browser sessions: a refresh cookie on one origin

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0005, ADR 0011, ADR 0014

## Context

ADR 0005 has the auth service issue the access and refresh tokens. Today auth returns both in the response body, sets no cookie and sends no CORS headers. A page reload therefore signs the user out, because the portal holds the tokens only in memory, and the portal's browser calls to auth and core are blocked. The local stack (hub issue 20) confirmed both. The decision is recorded from hub issue 41.

## Decision

1. **The refresh token lives in a cookie only the auth service receives.** Auth sets it as `HttpOnly`, `Secure`, `SameSite=Strict` and host-only (no `Domain` attribute). `HttpOnly` keeps script from reading it. Its `Path` is narrowed to auth's session routes, which limits which requests carry it; it is not isolation between services on one origin. Host-only and the narrowed `Path` are lead refinements of the owner's choice, recorded on hub issue 41, not separate decisions. Refresh and sign-out read it from the cookie.
2. **The access token stays in the portal's memory** and travels as a bearer header. It is never stored in the browser.
3. **The portal and the services are served from one origin.** The services sit under path prefixes behind the load balancer, which routes by path. Locally the portal's dev server proxies the same prefixes. Browser calls use same-origin paths, so there is no CORS and no CORS header to get wrong.
4. **Cookie-authenticated routes check `Origin`.** Refresh and sign-out also compare the request's `Origin` header with an allow-list and refuse any other value, as a second defence beside `SameSite=Strict`. A request from a sibling subdomain is same-site, so `Strict` lets it through; the `Origin` check refuses it. What happens when `Origin` is absent is left to the implementing ticket.
5. **Non-browser clients keep the token-in-body flow**, selected by an explicit client type on the request. For the browser client type the refresh token is never in a response body.

Subdomains of one site (for example `app.` and `api.`) are same-site but still cross-origin. They would need CORS with credentials. One origin is what removes CORS; being same-site does not.

## Considered options

- **The same cookie cross-origin, with CORS and CSRF tokens.** Rejected: it needs credentialed CORS configuration, and a CSRF token flow, each a way to get it wrong, to reach a result one origin gives with none of them.
- **A backend-for-frontend that holds the session** and talks to the services for the portal. Rejected: a new service on every request path, holding every session, for a problem path routing already solves.
- **Tokens in browser storage** (`localStorage`, `sessionStorage`). Rejected: any script running on the page, including a compromised dependency, can read and send them, and the refresh token is the credential that outlasts a page.

## Consequences

- A reload restores the session: the portal calls refresh on load, the cookie goes with it, and a new access token comes back into memory. Sign-out revokes the session on the server and clears the cookie, so no tab can refresh again; an access token already in another tab's memory lasts until it expires.
- Infrastructure must provide one origin with path routing to each service (hub issue 19). The paths must match the cookie's `Path` and the dev server's proxy.
- The cookie's name, the allowed origin and the exact session route paths are settings of the auth service, fixed by the implementing ticket.
- Because refresh and sign-out are cookie-authenticated, a test with a foreign `Origin` and with a sibling-subdomain `Origin` must show both refused.
- The known-device cookie of ADR 0014 is a separate cookie, set and verified by the lockout work (hub issue 30), not by this one.
- How local development over plain http is handled is left to the implementing ticket. Any relaxation of `Secure` must be refused outside `ENVIRONMENT=local`.
- Script running on the page, for example through an XSS flaw, still cannot read the refresh token but can call refresh and obtain an access token. The cookie narrows what a flaw can steal; it does not replace preventing one.
- Concurrent refreshes from several tabs holding the same cookie must not trigger reuse detection or end the session. How is left to the implementing ticket, which tests it with two concurrent refreshes.
- Cookie sessions move auth further from tula-auth, the code it was copied from (ADR 0005).

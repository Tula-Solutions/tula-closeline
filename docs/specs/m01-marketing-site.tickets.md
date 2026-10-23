# M1 Marketing site: tickets

Order: hub, contract, db, core (the demo-request path), then portal pages. The portal page tickets
that do not need the form (T6 to T8) can run in parallel with T2 to T4 and with one another once T5
has landed. Visual direction and the BANNED list are in the spec; every portal ticket is checked
against them in review.

### T1: Hub: glossary terms Visitor and Demo Request
Repo: hub
Blocked by: none

## What to build
Add the two proposed terms to `GLOSSARY.md` and sync. Nothing else changes for users.

## Acceptance criteria
- [ ] **Visitor** and **Demo Request** are in `GLOSSARY.md` with a definition and an `_Avoid_` list, as in the spec
- [ ] `bun run sync` has copied the glossary to every sibling clone and `bun run verify` is green in the hub

### T2: Contract: the `marketing` area and demo request route
Repo: contract
Blocked by: none

## What to build
A public `POST` for a Demo Request: name, work email, company name, optional message, source page, a client idempotency key and a honeypot field. Response is an acknowledgement with an id. Error codes `marketing.invalid_request` and `marketing.rate_limited`. Tag a release.

## Acceptance criteria
- [ ] Schemas reject an empty name, a malformed email, a message over 2,000 characters and an unknown key
- [ ] Error codes appear in the contract's code list and OpenAPI output
- [ ] `dist/` is rebuilt and committed, the version is bumped and the tag is named in the PR

### T3: Db: the `demo_request` table
Repo: db
Blocked by: T2

## What to build
A table in core's schema for Demo Requests with a unique idempotency key, a notification status (`pending`, `sent`, `failed`) and a submitted-at time, outside tenant row-level security and on the catalog allowlist. An index supports the retention purge.

## Acceptance criteria
- [ ] Migration is generated, applies and rolls forward on the harness; `db:check` is green
- [ ] The catalog check passes with the table on the allowlist and fails if a tenant role is granted `SELECT` on it
- [ ] A second Organization's role cannot read any row (harness test)
- [ ] Tag released

### T4: Core: accept, store and email a Demo Request
Repo: core
Blocked by: T2, T3

## What to build
A visitor's submission is stored once, acknowledged, and a `team-notice` email is queued to the configured team address through the outbox; a mail failure never fails the request. Per-address rate limit in Postgres; honeypot; body size limit; idempotent by key. A scheduled purge removes requests older than twelve months. Shows up in Mailpit locally.

## Acceptance criteria
- [ ] HTTP route test: valid request returns 201 and one stored row and one queued notice
- [ ] The same idempotency key returns the first result and stores nothing new
- [ ] Invalid body returns `marketing.invalid_request`; the request after the limit returns `marketing.rate_limited` with a retry-after value
- [ ] A throwing mail adapter still returns 201, the notice stays `pending` and a retry sends it once
- [ ] A filled honeypot returns 201 and stores nothing
- [ ] A token from any Organization cannot read demo requests through any route (second-Organization test)
- [ ] The message body never appears in logs
- [ ] `dev:smoke` posts a request and finds the email in Mailpit; a changed OpenAPI is committed

### T5: Portal: signed-out home at `/`, shell, tokens and copy guard
Repo: portal
Blocked by: none

## What to build
The marketing layout (header with wordmark, five links, Sign in and Book a demo; footer with legal links and Region note), the broadsheet grid and type scale, the balance-scale hero SVG with scroll tilt, the home page story in the glossary's words, and the `/` split: visitors see the site, signed-in members still see Home. Logo files copied from the logos folder. Per-route title, description and share image. The copy-guard test lands here.

## Acceptance criteria
- [ ] Signed-out `/` renders the site home; signed-in `/` renders Home (route tests)
- [ ] Exactly one `h1`, a skip link, visible focus, no axe violations in light and dark
- [ ] The scale is still under `prefers-reduced-motion`
- [ ] The copy-guard test fails on a fixture containing an emoji, "lead" used for a Prospect, or an unsourced "98%"
- [ ] Review against the BANNED list: no icon chips, card grids, gradients, stat tiles, logo wall, emoji or testimonials
- [ ] Checked in `agent-browser` at 360px and 1280px, both themes, with screenshots in the PR

### T6: Portal: product pages for Copilot, Inbound Agent, Outbound Agent and Playbook
Repo: portal
Blocked by: T5

## What to build
Four pages on one typeset template: a statement, "How it works" in numbered mono sections, one specimen illustration captioned "Illustration, invented for this page", and a "Built today / Planned (phase N)" ledger set as a ruled list. The Playbook page describes what is built (Documents, Calls, Deal Outcomes, Moment search); the Copilot and Agent pages say Planned with their phase.

## Acceptance criteria
- [ ] Each page is reachable from the header and the home page and has a unique title and description
- [ ] A feature not built is labelled Planned in text; none is shown as working
- [ ] Copy-guard, axe and the BANNED review pass; no screenshot or number is invented
- [ ] Specimen captions are present on every illustration

### T7: Portal: public pricing page
Repo: portal
Blocked by: T5

## What to build
A rate-card table from one typed pricing module: plans, monthly price, what is included, what is metered and its unit price, "Planned" flags, and a plain statement of monthly terms and cancellation. A "Book a demo" link for questions, not as a gate.

## Acceptance criteria
- [ ] Prices render from the typed module only; changing a value changes the page and nothing else needs editing
- [ ] The module's types require every price, and the route is not registered until the lead has supplied values
- [ ] The page states currency, billing period and cancellation terms; copy-guard passes
- [ ] The table is readable at 360px without horizontal page scroll

### T8: Portal: security and trust page
Repo: portal
Blocked by: T5

## What to build
A page that lists each rule as a numbered entry with how it is enforced and a link to its decision record where public: Contact Consent before Agent contact, AI and recording disclosure on every Call, Organization isolation, Region boundary, no secrets in logs, deletion. Entries for what is not yet built say so.

## Acceptance criteria
- [ ] Every entry has "Enforced by" text naming a mechanism, or the label Planned
- [ ] No certification (SOC 2, ISO, CASA) is claimed
- [ ] Copy-guard and axe pass

### T9: Portal: book-a-demo form
Repo: portal
Blocked by: T4, T5

## What to build
A form page posting to core: name, work email, company name, message. Inline field errors, input kept on failure, a confirmation state, a hidden honeypot, an idempotency key made per page load. The form never promises a reply time unless the lead confirms one.

## Acceptance criteria
- [ ] Screen test with a fake client: success shows the confirmation; `marketing.invalid_request` shows field errors with input kept; `marketing.rate_limited` shows a plain retry message
- [ ] A double click sends one request (same key)
- [ ] Labelled fields, error text linked with `aria-describedby`, keyboard-only completion works
- [ ] `/run-check`: submit against the local stack and see the email in Mailpit
- [ ] No tracking script added

### T10: Portal: sitemap, robots, share image and head tags
Repo: portal
Blocked by: T6, T7, T8, T9

## What to build
`robots.txt`, a sitemap of the marketing routes, canonical links, a share image in the broadsheet style (the Tula mark and type, no stock imagery), and a not-found page in the site's voice for unknown signed-out paths.

## Acceptance criteria
- [ ] Sitemap lists exactly the marketing routes and excludes app routes and sign-in
- [ ] Each page has a canonical URL and share tags
- [ ] Unknown signed-out paths show the not-found page with a link home

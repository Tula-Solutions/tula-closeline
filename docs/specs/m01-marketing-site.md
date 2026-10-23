Phase: 1 (finish) · Repos: portal, contract, db, core, hub · Parity rows: R96 (published pricing); report 2.2 (home, demo form), 6 (no fabricated proof)

# M1 Marketing site

## Problem Statement

A visitor who lands on Closeline today meets a sign-in form. There is no page that says what the product is, what it costs, how it treats the people it contacts, or how to talk to us. The competitor's site hides its price behind a demo, leans on a customer carousel that TechCrunch reported included customers that were not (research report, section 6), and says nothing verifiable about consent or disclosure (R90, R91). We want the opposite: a site that explains the product plainly, publishes the price, claims nothing we cannot show, and captures demo requests reliably.

## Solution

A marketing site inside the portal, shown at `/` to signed-out visitors; signed-in members keep Home at `/` (lead decision, parity analysis section 5). Pages: home, four product pages (Copilot, Inbound Agent, Outbound Agent, Playbook), pricing, security and trust, and a "book a demo" form. A submitted Demo Request is stored by core and emailed to the team.

**Story.** Closeline is a balance scale: a solid pan for the AI, an open pan for the human. A Copilot advises the Rep, Agents sell on their own, and a Playbook learned from the Organization's own won Deals sits under both. Trust is by construction: no Agent contacts a Prospect without a Contact Consent, and every Call states that it is AI and recorded (ADR 0003).

**Visual direction: "the broadsheet".** The site reads like the front page of a well-set newspaper, in the portal's existing ink-and-paper system.
- Ground paper `#F1EFE8` with the existing paper grain; text ink `#1A1A18`; dark mode inverts through the portal's existing tokens. No new colours. Once per page, one full-bleed ink band with paper text.
- Newsreader for display at very large sizes with tight tracking and italics for emphasis; Inter Tight for text; JetBrains Mono for section numbers (`01 / Copilot`), labels and figures.
- A twelve-column grid divided by hairline rules, vertical as well as horizontal, like newspaper columns. Sections open with a mono numeral and a rule, not an icon.
- The hero is the balance scale drawn from the Tula mark: beam, solid pan, open pan. Its only motion is a slow tilt as the page scrolls, and it is still under reduced-motion.
- Product explanations are typeset "specimens": a real-looking Moment card, a Contact Consent record, a Playbook citation, each captioned "Illustration, invented for this page". They are set in the same type as the page, with hairline borders and no shadow.
- Pricing is a typeset table with rules, like a rate card.

**BANNED** (the reviewer checks each): icon chips or icon circles on headings or list items; grids of uniform rounded cards; gradient blobs, glows and mesh backgrounds; dashed-border empty states; stat-tile rows ("3x", "98%"); "trusted by" logo walls, customer logos, testimonials, quotes, case studies and any metric we have not measured and can show the source of; emoji; stock photography and generic AI imagery; drop-shadow cards; pill badges ("New", "Popular"); carousels; chat-bubble hero mockups; gradient text; sparkle icons; the words in the GLOSSARY `_Avoid_` lists (lead, contact for Prospect, customer, workspace, SDR, bot, and so on).

**Honesty rules.** No fabricated customers, logos, quotes, numbers or "as seen in". A claim about behaviour (consent, disclosure, recording) links to the rule that enforces it or is not made. A feature that is not built is labelled "Planned" in plain text, with its phase, never shown as working. Copy is written fresh; 11x's copy and layout are not used.

## User Stories

1. As a visitor, I want the home page to tell me in a few seconds what Closeline is, so that I can decide whether to read on.
2. As a visitor, I want to see the Copilot, the Inbound Agent, the Outbound Agent and the Playbook explained on their own pages, so that I understand how they fit together.
3. As a visitor, I want a page for each product to say what is built today and what is planned, so that I am not sold something that does not exist.
4. As a visitor, I want the price on a public page, per month, so that I can budget without a sales call.
5. As a visitor, I want pricing to state what is metered and what is included, so that no charge surprises me.
6. As a visitor, I want a security and trust page, so that I can see how Contact Consent, disclosure, tenant isolation and Regions work.
7. As a visitor, I want the trust page to name each rule and say whether it is enforced by the system, so that I can tell promise from mechanism.
8. As a visitor, I want to book a demo by giving my name, work email, company name and what I want to see, so that the team can reach me.
9. As a visitor, I want a clear confirmation, and an email, when I submit the form, so that I know it arrived.
10. As a visitor, I want a failed submission to keep what I typed and say what to fix, so that I do not retype it.
11. As a visitor on a phone, I want every page readable and the form usable at 360px width, so that I can use the site anywhere.
12. As a visitor using a keyboard or a screen reader, I want a skip link, visible focus, correct headings and labelled fields, so that the site is usable without a mouse.
13. As a visitor who prefers reduced motion, I want the scale to stay still, so that the page does not make me ill.
14. As a visitor in dark mode, I want the site to follow my system theme, so that it is easy on the eyes.
15. As a visitor, I want to go from any page to sign in or sign up, so that I can start without hunting.
16. As a visitor, I want links to a privacy notice and terms in the footer, so that I know how my demo details are used.
17. As a visitor, I want my demo details used only to contact me about the demo, so that I am not added to a list.
18. As a member who is signed in, I want `/` to remain my Home, so that nothing changes for me.
19. As a member whose session has expired, I want `/` to show the site and not an error, so that I can sign in again.
20. As a Closeline team member who receives Demo Requests, I want each request emailed to a team address, so that nobody checks a dashboard.
21. As that team member, I want a request stored even if the email fails, so that none is lost.
22. As that team member, I want repeated submissions of the same form to produce one request, so that a double click does not create two.
23. As that team member, I want automated spam rejected without blocking real people, so that the inbox stays useful.
24. As a Closeline engineer, I want a test that fails if marketing copy contains an emoji or a glossary `_Avoid_` term, so that the banned list cannot erode.
25. As a Closeline engineer, I want prices kept in one typed place, so that the page and the billing work cannot disagree.
26. As the owner of the brand, I want only the Tula assets from the logos folder used, so that the mark is never redrawn.
27. As a visitor, I want a page title, description and share image on every page, so that links I share look right.
28. As a visitor on a slow connection, I want the home page to load without blocking on large images or fonts, so that I can read at once.

## Implementation Decisions

- **Portal owns the site.** Marketing routes sit in the signed-out layout. The `/` route resolves by session: signed-in shows Home; signed-out shows the site home. Marketing pages and the app layout stay separate so app code is not loaded for visitors where the router allows.
- **Brand assets** are copied from the logos folder into the portal's public assets (mark, horizontal lockup, favicon already present, one share image). The scale illustration is an inline SVG derived from the mark's own paths.
- **Pricing data** is a typed module in the portal (plan name, monthly price, currency, included quantities, metered unit prices, "Planned" flags). Billing (core, phase 5) later becomes the source and the page reads from the contract. The numbers are a product decision (see Further Notes).
- **Demo Requests are owned by core**, as a platform-level record with no `organization_id` (a visitor has no Organization). It is a new core module with router, service and schema, one route: a public, unauthenticated `POST` in a new contract area `marketing` (`demo_request`), idempotent by a client-generated key, validated by Zod, rate-limited per client address in Postgres (not process memory), with a honeypot field and a bounded body size.
- **Storage**: one table in core's schema, `demo_request` (id, name, work email, company name, message, source page, submitted at, idempotency key unique, notification status). The table sits outside tenant row-level security like the directory tables of ADR 0011, is on the db library's allowlist, and no tenant request can read it; only the team address receives its content. A retention limit (twelve months) is enforced by a scheduled purge.
- **Emailing the team** goes through the existing mail port with a new `team-notice` message type, queued through an outbox like the Invitation mail (hub issue 35), so a mail outage never fails the request. Recipient address is an environment setting. Mailpit shows it locally.
- **Errors** use `marketing.*` codes: `marketing.invalid_request`, `marketing.rate_limited`.
- **No analytics or tracking scripts** are added; if added later it is a separate decision.
- **Copy guard**: a portal test reads the marketing copy modules and fails on emoji, `_Avoid_` terms from the glossary, and on digits followed by `%` or `x` not present in a short allowlist file that cites its source.
- **SEO**: per-route titles and descriptions, an Open Graph image, `robots.txt` and a sitemap. The site is a client-rendered SPA; static prerendering of marketing routes is deferred (lead decision to revisit when SEO needs it).

## Testing Decisions

- Test the HTTP route in core through the app with the memory adapters: a valid request stores one row and queues one notice; the same idempotency key twice stores one; an invalid body returns `marketing.invalid_request`; the 11th request in the window from one address returns `marketing.rate_limited`; a mail adapter that throws still returns success and leaves the notice pending for retry; a filled honeypot returns success and stores nothing.
- Cross-Organization isolation: a member's token from any Organization cannot read demo requests through any route, and the table is absent from tenant-scoped helpers (the db catalog check covers this; add the table to its allowlist test).
- Portal tests at the route level with Testing Library and a fake client: signed-out `/` renders the site; signed-in `/` renders Home; each page has one `h1`; the form shows field errors, preserves input on failure, and confirms on success.
- The copy guard test above, and an automated accessibility check (axe) on each page in light and dark.
- Prior art: invitation tests in core (router.test.ts, mailer tests) and the sign-in and sign-up screens' tests in the portal. `/run-check` loads each page in `agent-browser` at 360px and 1280px in both themes and submits the form against the local Mailpit; `dev:smoke` gains a demo-request step.

## Out of Scope

- A "hear the Copilot" audio or voice sample: it waits for a real Copilot (M13) and must be a real recording, never faked.
- Blog, changelog, comparison pages, case studies, and customer proof of any kind.
- Server-side rendering or prerendering, A/B testing, analytics, a cookie banner (nothing needing one is added).
- Self-serve checkout and the billing system (phase 5).
- Legal text itself: privacy notice and terms are written and reviewed by a lawyer; the site only links to them.
- Localisation.

## Further Notes

- **Proposed GLOSSARY terms.**
  - **Visitor**: a person browsing Closeline's public site who has not signed in. _Avoid_: user, lead, traffic.
  - **Demo Request**: a visitor's submitted wish to see Closeline, held by Closeline itself and not by any Organization. _Avoid_: lead, enquiry, signup.
- **ADR needed:** none for the site itself. A short ADR is worth writing for "platform-level records outside tenant row-level security" if more than the demo table needs it; today it extends ADR 0011's directory pattern.
- **Open decisions for the lead:** the plan names and monthly prices; the team address that receives requests; the legal pages' owner. The site cannot ship pricing without the first.
- **11x rows:** R96 (published, self-serve pricing; 11x has none). It also answers the report's section 6 weaknesses (fabricated proof, lock-in) by making "monthly, cancel any time" a stated term once the lead confirms it.
- The balance-scale hero depends on the Tula mark being a scale; the asset in the logos folder is the reference.

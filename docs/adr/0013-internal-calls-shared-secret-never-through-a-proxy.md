# ADR 0013 — Internal calls: a shared secret, never through a proxy

**Status:** Accepted
**Date:** 2026-10-13
**Builds on:** ADR 0005, ADR 0007, ADR 0011

## Context

Services call each other over HTTP when an answer is needed now (ADR 0007): auth calls core during sign-up (ADR 0011) and when it issues a token (ADR 0005). Those calls carry a bearer token and user ids. Two things about them were unstated: how a service proves who is calling, and where the call may travel.

The second came from the review of auth's membership adapter (hub issue 39). Bun's `fetch` honours `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` and exempts no host unless `NO_PROXY` names it. If a proxy variable is set in a service's environment, every call to core goes through that proxy with the bearer token and the user ids. Nothing sets one today. A proxy variable left in a container image, a task definition or a developer's shell would silently change where secrets travel. In the Bun version tested, deleting the variable from `process.env` at run time did not stop later `fetch` calls from using it.

## Decision

1. **Services authenticate to each other with a shared secret in a bearer header.** Each calling service has its own secret. The receiver compares it in constant time.
2. **Rotation is two secrets at once.** The receiver accepts the old and the new secret for a caller until the caller has moved over, then drops the old one.
3. **Internal routes are never exposed through the public load balancer.** Only the routes the portal and other clients are meant to call are routed there.
4. **Service-to-service calls never go through an HTTP proxy named in the environment.** They use a transport that ignores proxy variables, or the service refuses to boot unless `NO_PROXY` covers the internal hosts. A helper in `tula-closeline-kit` implements the choice, and every internal call uses it.
5. **Calls to outside vendors (models, the breach checker, HubSpot and the like) may use a proxy configured on purpose.**

## Considered options

- **Signed service tokens** (a short-lived token signed per call). Rejected for now: a signing key, an issuer and expiry handling for a handful of services whose callers a per-caller secret already tells apart. See the revisit condition below.
- **Network identity alone** (security groups or the private network decide who may call). Rejected: any process on the network, including one reached through a flaw in another service, would be trusted, and it gives the receiver nothing to check.
- **Refusing proxy variables entirely**, so a service fails at boot if any is set. Rejected: it rules out an egress proxy for vendor calls later without a change to every service.
- **Accepting and documenting that a proxy would carry the secret.** Rejected: it leaves the secret's path to whatever the environment happens to contain.

## Consequences

- A leaked secret lets its holder call as that one service until it is rotated; it does not give access to other callers' routes.
- Each receiver holds one secret per caller, and each caller holds the secret for each receiver it calls. Where they are stored, and how they reach the task definitions, is for infrastructure (hub issue 19). Task definitions set no proxy variable, and set `NO_PROXY` if the boot check is used.
- The kit helper needs a test that names a stand-in proxy in the environment and asserts the proxy sees no request. Each service that makes internal calls has a test showing the same through its own adapter. Which of the two mechanisms in decision 4 the helper uses is left to the implementing ticket.
- Internal calls keep the bounds ADR 0011 sets for sign-up: a timeout, a bounded, jittered retry, and an idempotency key where the call has effects.
- Revisit when there are more than a handful of services, or when a receiver needs to know which service made a call beyond what one secret per caller tells it. Signed service tokens are the first alternative to look at then.

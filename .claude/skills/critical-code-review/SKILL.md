---
name: critical-code-review
description: Reviews authentication-context consistency and reusable authorization policies for security-critical changes. Use when authentication or authorization code changes; complements the full Staff PR review.
---

# Critical Code Review

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

## Authentication context consistency

For every authentication or authorization change:

1. Trace where the credential is validated.
2. Trace where the authenticated principal is attached to the request.
3. Identify the canonical request property or context accessor.
4. Search for other properties representing the same principal.
5. Search for existing guards and policies.
6. Search for duplicated inline authorization checks.
7. Verify that authorization uses validated identity claims.
8. Verify that client-controlled input cannot override identity, role,
   permissions, tenant, or ownership.
9. Verify that missing context and insufficient permission are handled
   intentionally.
10. Verify isolated tests exist for the guard or policy.

Report a finding when:

* `request.user`, `request.backofficeUser`, `request.backOfficeClient`, or
  equivalent properties are used inconsistently for the same actor.
* A controller repeats an authorization rule already present elsewhere.
* A new guard is created without inspecting the authentication pipeline.
* A guard reads a property different from the one populated by authentication.
* A role is read from request input rather than validated identity.
* A decoded but unverified JWT payload is trusted.
* Authorization is tested only through controller tests.
* A new protected endpoint requires copying a conditional.

Do not accept duplicated authorization merely because each copy currently
contains the same comparison.

Security policies must have a single reusable implementation whenever the same
rule applies to multiple entry points.

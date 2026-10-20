---
name: api-documentation
description: Author and review API and application documentation for modified contracts using the project's existing documentation tooling, such as Swagger/OpenAPI. Use when endpoints, DTOs, integrations, configuration, or public behavior change. Notify the developer when no documentation tooling exists.
---

# API Documentation

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

The AI agent authors documentation for the behavior it modifies, as part of
the approved implementation. The developer reviews the changes and creates
commits; documentation is not left as a developer follow-up.

## Ownership and scope

Document only what the current task created or modified. Existing documentation
for untouched behavior is out of scope unless the user explicitly requests it;
do not backfill, reformat, or rewrite it. Update existing documentation only
where the modification made it inaccurate.

Use the project's existing documentation system, such as Swagger/OpenAPI
decorators or specs, AsyncAPI, GraphQL schema descriptions, or project guides,
and follow its established conventions. Write in English, preserving business
terminology and external API names/values.

When the project has no documentation tooling, do not add a tool, dependency,
or new documentation format. Produce no documentation and notify the developer
that the modified contract could not be documented and why.

Add explanatory comments only for non-obvious constraints, side effects, or
rationale in modified code; do not narrate self-explanatory code.

Executable validation schemas, types, serializers, and configuration remain
implementation responsibilities even when they also generate documentation.
Do not leave runtime behavior incorrect under the documentation ownership rule.
Mandatory changelog and version bookkeeping is handled by `release-changelog`.

## Establish the actual contract

Trace the route or entry point, DTOs, validators, authentication, authorization,
business operation, persistence, external adapters, serialization, errors, and
existing tests. Inspect callers and similar implementations before deciding
which contract is authoritative. Do not assume that prose or static types prove
runtime behavior. When intent is genuinely ambiguous, report the uncertainty
rather than inventing a contract or changing code to fit stale prose.

Identify the existing documentation system before writing. Document and review
only the sections affected by the change; do not require every possible
documentation field for every endpoint.

## Content criteria

Cover the applicable consumer-facing details of the modified contract:

- Purpose, actors, prerequisites, authentication method, permissions, tenant
  boundaries, ownership, and administrative restrictions.
- Request body, path/query/header inputs, types, required versus optional and
  nullable fields, defaults, formats, enums, bounds, cross-field constraints,
  unknown fields, and immutable values.
- Normalization, masks, preserved whitespace/case, password and signature
  integrity, units, monetary precision, date format, and timezone semantics.
- Success status and response schema, error status and safe error payloads,
  validation feedback, and the distinction between asynchronous acceptance and
  completed processing.
- Pagination limits and ordering, filtering combinations, sorting allowlists,
  boolean false versus omission, empty results, and binary/download responses.
- State transitions, side effects, transactions visible to consumers,
  idempotency scope, retry safety, duplicate delivery, webhooks, timeouts,
  partial failure, and recovery behavior.
- Upload limits and accepted content, configuration requirements/defaults,
  versioning, deprecation, compatibility, and migration or operational guidance.
- Accurate examples for success and important failure/alternative scenarios,
  consistent operation identifiers, resolved schema references, discriminated
  unions, nested DTOs, and generated clients when affected.

Do not invent provider guarantees, rate limits, retirement dates, permission
rules, or delivery semantics. Distinguish observed behavior from unresolved
business intent. An external provider's field names and response values must
remain intact where they are part of the contract.

## Safety and useful explanations

Flag documentation containing real credentials, tokens, personal data,
production payloads, private infrastructure details, or instructions that could
encourage unsafe use. Examples must be fictional and schema-compatible; never
copy production logs and label them fictional.

Prefer explanations of non-obvious constraints, side effects, and rationale.
Do not request comments that narrate syntax, duplicate field names, or repeat
self-explanatory code. Report stale claims that could mislead a maintainer even
when the implementation itself is correct.

## Validation

Run applicable existing contract checks, schema validation, example validation,
or documentation generation in a temporary location when supported. Do not
publish output externally. Inspect generated output before relying on it. A
large snapshot alone does not prove a contract; verify relevant semantics
against validators and consumers.

Do not add dependencies to author or validate documentation. Report unavailable
tools and unverified behavior.

## Findings and handoff

Report what documentation was added or updated and what validation actually
ran. When documentation could not be produced, state the reason, such as missing
tooling or an unresolved contract question.

During review, for each distinct gap in modified documentation, identify the
incorrect or missing contract information, the supporting behavior, why a
consumer or maintainer could be misled, and the correction. Classify severity by
practical impact; do not make missing prose automatically Critical or High.

When included in Staff review, use `../staff-review/SKILL.md` for presentation
and deduplication. In Claude, use only Category, Problem, and Description, without
file locations. Separate documented defects from questions about unknown intent.

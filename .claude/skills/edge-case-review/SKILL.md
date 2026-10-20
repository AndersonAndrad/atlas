---

name: edge-case-review
description: Systematically challenges implementations with boundary values, malformed input, unusual states, duplicate execution, concurrency, partial failures, Unicode, large payloads, empty values, unexpected ordering, and compatibility scenarios. Use after implementing behavior changes and before final validation.
---

# Edge Case Review

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

Review the implementation by actively trying to break it.

The goal is to identify realistic scenarios that are not covered by the happy
path.

Do not generate arbitrary test cases only to appear thorough.

Prioritize edge cases that can affect:

* Correctness
* Security
* Data integrity
* Financial behavior
* User experience
* Availability
* Compatibility
* Operations in production

## 1. Understand the affected behavior

Before generating edge cases:

1. Identify the entry points affected by the change.
2. Trace the complete execution flow.
3. Identify input boundaries.
4. Identify state transitions.
5. Identify external dependencies.
6. Identify persistence behavior.
7. Identify retry and duplicate execution paths.
8. Inspect existing tests.
9. Inspect similar implementations.
10. Identify assumptions made by the implementation.

Do not review only the changed function.

## 2. Classify the reviewed flow

Determine which categories apply:

* Text input
* Numeric input
* Dates and time
* Collections
* Files
* Authentication
* Authorization
* State transitions
* Persistence
* External integrations
* Background jobs
* Queues
* Payments
* Frontend forms
* Search and filtering
* Pagination
* Caching
* Concurrency
* Configuration
* Public APIs

Apply only relevant categories.

## Input and identity edge cases

Use for missing/text/numeric/date/collection values, pagination, identifiers,
authentication, authorization, and normalization boundaries. Read [references/inputs-and-identity.md](references/inputs-and-identity.md)
only for the applicable categories.

## State and integration edge cases

Use for state transitions, duplicates, concurrency, persistence, caches,
external providers, queues, jobs, files, and uploads. Read [references/state-and-integrations.md](references/state-and-integrations.md)
only for the applicable categories.

## UI and operational edge cases

Use for frontend interactions, error contracts, backward compatibility,
configuration, and resource limits. Read [references/ui-and-operations.md](references/ui-and-operations.md)
only for the applicable categories.

## 26. Generate a focused edge-case matrix

Produce a matrix containing only relevant scenarios.

Use:

| Scenario             | Expected behavior            | Current coverage | Risk | Action                |
| -------------------- | ---------------------------- | ---------------- | ---- | --------------------- |
| Empty value          | Reject with validation error | Covered          | Low  | None                  |
| Password with spaces | Preserve exactly             | Missing          | High | Add regression test   |
| Duplicate request    | Return existing result       | Partial          | High | Add idempotency check |

Do not create hundreds of low-value scenarios.

Prioritize:

1. Critical business rules
2. Security boundaries
3. Data integrity
4. Duplicate execution
5. External failures
6. Boundary values
7. User-visible failures

## 27. Ask material questions

Ask the developer when expected behavior cannot be safely inferred.

Good question structure:

### Question

What should happen when the same request is submitted twice?

### Why this matters

A timeout or repeated click may cause the operation to execute more than once.

### Current behavior

The implementation creates a new record on every request and has no uniqueness
or idempotency check.

### Options

1. Return the previously created result.
2. Reject the duplicate.
3. Allow duplicates.
4. Use another domain-specific rule.

Do not ask questions when existing tests, contracts, or established project
behavior already provide the answer.

## 28. Apply corrections

After edge cases are confirmed:

1. Apply the smallest complete correction.
2. Add validation at the correct boundary.
3. Add regression tests.
4. Add database constraints when needed.
5. Add idempotency protection when needed.
6. Improve error handling.
7. Preserve confirmed behavior.
8. Avoid unrelated refactoring.
9. Re-run the affected validation commands.
10. Review the final diff.

Do not change valid business behavior based only on speculation.

## 29. Required tests

When applicable, add tests for:

* Missing values
* Null values
* Empty values
* Boundary values
* Invalid values
* Oversized values
* Unicode
* Duplicate execution
* Concurrent execution
* Unauthorized access
* Wrong state
* External timeout
* External rejection
* Partial failure
* Old data
* Backward compatibility
* Regression scenarios

Prefer a smaller set of high-value tests over a large set of repetitive tests.

## 30. Review output

Provide:

## Reviewed flow

Describe the behavior and boundaries reviewed.

## Highest-risk edge cases

List the most important scenarios first.

## Edge-case matrix

Include expected behavior, current coverage, risk, and required action.

## Questions

Ask only questions that materially affect the correction.

## Safe corrections

List corrections that can be applied without unclear business decisions.

## Missing tests

List the highest-value tests that should be added.

## 31. Final report after corrections

After applying corrections, provide:

## Edge cases covered

List the scenarios now protected.

## Corrections applied

Describe implementation changes.

## Tests added or updated

Describe the behavior covered.

## Validation executed

List only commands actually executed.

## Remaining risks

State accepted, deferred, or unverified scenarios.

## Final status

Use exactly one:

* Validated
* Partially validated
* Not validated

## 32. Anti-patterns

Do not:

* Generate random edge cases unrelated to the domain.
* Focus only on null values.
* Ignore duplicate execution.
* Ignore concurrency.
* Assume external timeouts are safe.
* Treat every theoretical case as a blocker.
* Reject Unicode without a domain reason.
* Normalize sensitive values.
* Add broad abstractions for one edge case.
* Add locking without a demonstrated race condition.
* Ask questions already answered by the repository.
* Claim coverage without tests.
* Claim validation without running commands.
* Produce an enormous checklist with no prioritization.

The review is valuable only when it identifies realistic failure scenarios and
leads to concrete protection.

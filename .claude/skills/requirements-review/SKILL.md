---

name: requirements-review
description: Reviews requirements before implementation to identify ambiguity, missing business rules, hidden assumptions, affected flows, acceptance criteria, compatibility risks, security implications, edge cases, and validation needs. Use before implementing features, changing behavior, fixing complex bugs, modifying public contracts, or starting work with incomplete requirements.
---

# Requirements Review

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

Review the requirement before modifying production code.

The objective is to ensure that the implementation solves the correct problem,
covers the expected behavior, and does not rely on unsafe assumptions.

Do not start implementing a non-trivial change until the requirement has been
reviewed.

## Acceptance criteria before implementation

Define a small set of observable criteria from the request, existing contracts,
and tests before editing. For each changed behavior, identify the trigger,
expected result, important failure cases, forbidden side effects, and behavior
that must remain compatible. Map each criterion to an appropriate test or check.

For a bug fix, include the reproducing scenario and the expected corrected
result. For a non-behavioral change, identify the invariant to preserve and its
validation. Keep this compact for small tasks; do not require a separate
requirements document or a second approval beyond `implementation-plan`.
Ask only about uncertainty that materially changes safety,
business behavior, or compatibility. Do not invent requirements.

Update criteria when the user changes scope, then compare the final behavior
and validation evidence against them. Documentation for modified contracts is
part of the deliverable when the project has documentation tooling.

## 1. Understand the requested outcome

Identify:

* What problem must be solved
* Who is affected
* What behavior is expected
* What behavior must remain unchanged
* What input starts the flow
* What output or observable result is expected
* Which failures must be handled
* How success will be validated

Do not confuse the requested implementation with the actual desired outcome.

A requirement such as:

> Add a trim interceptor.

may represent a broader objective such as:

> Prevent accidental whitespace in specific textual fields without altering
> passwords, tokens, secrets, or meaningful user content.

Review the objective, not only the proposed technical solution.

## 2. Inspect existing behavior

Before asking questions or proposing changes:

1. Inspect the relevant entry points.
2. Trace the affected execution flow.
3. Search for similar behavior in the project.
4. Inspect existing validation rules.
5. Inspect tests.
6. Inspect public contracts.
7. Inspect frontend and backend behavior when both are affected.
8. Inspect database and integration constraints when applicable.

Do not ask the developer questions that the repository already answers.

## 3. Separate facts from assumptions

Classify the requirement details internally as:

### Confirmed

Explicitly defined by:

* The task description
* Existing tests
* Public contracts
* Current business rules
* Project documentation
* Existing implementation patterns
* Direct developer answers

### Inferred

Likely behavior based on context, but not explicitly confirmed.

### Unknown

Behavior that cannot be safely determined.

Do not implement behavior classified as unknown when it can affect:

* Business rules
* Data integrity
* Security
* Authorization
* Financial operations
* Public contracts
* User-visible behavior
* External integrations
* Backward compatibility

Ask targeted questions first.

## Requirement dimensions

Use for actors, permissions, inputs, state, errors, idempotency, concurrency,
data, contracts, UI, security, integrations, and observability. Do not invent
requirements or require every category for a small change. Read [references/requirement-dimensions.md](references/requirement-dimensions.md)
only for the applicable categories.

## 16. Define acceptance criteria

Convert the requirement into testable statements.

Good acceptance criteria are:

* Observable
* Specific
* Testable
* Independent from implementation details
* Clear about success and failure
* Clear about permissions
* Clear about edge cases

Example:

### Weak

* Trim user fields.

### Better

* Leading and trailing spaces are removed from `name`, `email`, and `city`.
* Internal spaces in names are preserved.
* Passwords, tokens, API keys, and free-form messages are not modified.
* Email normalization is applied before uniqueness validation.
* The backend applies the same rules when called without the frontend.
* Tests cover allowed, rejected, and preserved values.

## 17. Define validation scenarios

Before implementation, identify tests for:

### Happy path

The expected successful flow.

### Invalid input

Missing, malformed, empty, oversized, or unsupported values.

### Boundaries

Minimum, maximum, zero, empty collections, and limits.

### Permissions

Unauthenticated, unauthorized, and resource ownership scenarios.

### Failure paths

Database, provider, timeout, parsing, and infrastructure failures.

### Duplicate execution

Repeated request, double-click, retry, and queue redelivery.

### Compatibility

Existing consumers, old records, and unchanged behavior.

### User experience

Loading, errors, disabled states, keyboard behavior, and responsive behavior.

## 18. Identify implementation impact

List the areas that may need changes:

* Frontend components
* Form validation
* API contracts
* DTOs or schemas
* Controllers or handlers
* Services
* Domain rules
* Persistence
* Migrations
* Integrations
* Cache
* Queues
* Logs
* Metrics
* Tests
* Documentation
* Environment configuration
* Deployment
* Rollback

Do not modify every listed area automatically.

Use the list to identify the real implementation scope.

## Questions and decisions

Use when ambiguity materially affects behavior or safety. Preserve the
implementation-plan approval gate even when clarification is unnecessary. Read [references/questions-and-decisions.md](references/questions-and-decisions.md)
only for the applicable categories.

## 25. Anti-patterns

Do not:

* Begin implementation before understanding the desired outcome.
* Treat the proposed technical solution as the requirement.
* Invent business rules.
* Ask questions answered by the repository.
* Ask generic or low-value questions.
* Normalize all strings blindly.
* Assume retries are safe.
* Assume frontend validation is sufficient.
* Ignore existing records.
* Ignore permissions.
* Ignore compatibility.
* Ignore loading and failure behavior.
* Accept vague criteria such as “must work”.
* Produce an oversized design for a small change.
* Block implementation over insignificant uncertainty.

The review must reduce real implementation risk, not create unnecessary
bureaucracy.

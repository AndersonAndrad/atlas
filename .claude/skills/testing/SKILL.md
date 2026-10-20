---
name: testing
description: Defines mandatory testing practices for features, bug fixes, refactors, endpoints, business rules, integrations, and behavior changes. Use during implementation and before declaring any code task complete.
---

# Testing

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

Tests must validate behavior, not merely increase coverage.

## Mandatory coverage for new code

Every new executable behavior must have automated tests delivered with it,
including validation, guards, policies, error paths, and reusable helpers.
Test only what the task created or modified, including existing behavior the
change affects; do not add tests for untouched pre-existing behavior unless the
user requests it.
Prioritize unit tests, then mocked end-to-end coverage for user journeys, and
integration tests for real framework, persistence, and adapter contracts.
Choose the levels that prove the behavior; priority does not justify omitting
integration coverage where mocks cannot prove a contract.

Documentation-only changes require structural and semantic validation rather
than artificial executable tests that merely match instruction wording.

## Before writing tests

Identify:

- Expected successful behavior
- Expected failures
- Boundary values
- Invalid inputs
- Permission failures
- External dependency failures
- Existing behavior that must remain unchanged

## Test selection

Use the lowest test level that proves the behavior reliably.

### Unit tests

Use for:

- Business rules
- Pure transformations
- Validation logic
- Isolated error handling
- Deterministic calculations

### Integration tests

Use for:

- Persistence behavior
- Framework configuration
- Database queries
- External adapters
- Serialization
- Authentication and authorization flows

### End-to-end tests

Use for critical flows that require validating the complete application
behavior.

Do not replace all unit and integration tests with end-to-end tests.

## Mocked end-to-end boundaries

End-to-end tests must always mock external services and third-party integrations.
For frontend journeys, mock backend responses; for backend journeys, exercise
the local application while replacing outbound integrations with controlled
fixtures. Keep the behavior under test real. Never call live providers or use
production data or credentials. Fail unexpected outbound requests, reset mocks
between tests, and cover successful, invalid, denied, timeout, and failure
responses as applicable. Use integration tests with isolated local resources
to verify contracts that these mocks cannot establish.

## Bug fixes

Every bug fix should include a regression test when reasonably possible.

The regression test should:

1. Fail before the correction.
2. Pass after the correction.
3. Represent the real failure scenario.

## Required scenarios

When applicable, test:

- Valid input
- Invalid input
- Missing input
- Boundary values
- Empty collections
- Duplicate operations
- Unauthorized access
- Forbidden access
- Resource not found
- Dependency timeout
- Dependency failure
- Concurrent or repeated execution
- Backward compatibility

## Test quality

Tests must:

- Have descriptive names
- Avoid unnecessary implementation details
- Be deterministic
- Avoid real external services
- Clean up created state
- Make failures understandable
- Assert meaningful outcomes

Do not weaken an existing test merely to make a new implementation pass.

## Tests must detect meaningful failures

Derive assertions from acceptance criteria and public behavior, not a copy of
the implementation's branches or calculations. Verify outputs, persisted state,
and both required and forbidden side effects. Ask whether the test would fail
if the relevant validation, permission check, or state transition were broken.
For regressions, demonstrate failure before the fix when feasible, without
reverting the developer's working tree.

Mock external boundaries and nondeterminism, not the rule under test. Keep
fixtures consistent with actual contracts. Mocked end-to-end tests do not prove
real serialization, database constraints, or transaction behavior; cover these
with integration tests against isolated resources when affected.

Use snapshots only for intentionally stable, bounded output that a reviewer can
inspect. Pair them with focused semantic assertions where behavior matters.
Never refresh snapshots blindly or use a large snapshot as the only proof of
correctness. Coverage percentages and call-count assertions alone do not prove
requirements; call counts are useful when duplicate side effects are the risk.

Control clocks and randomness, avoid arbitrary sleeps, isolate state, and await
observable completion. Do not add retries to hide flaky tests. Test concurrent
writes with meaningful coordination instead of hoping timing exposes a race.

## Execution

Run the smallest relevant test set during development.

Before completion, run the broader project test commands when practical.

Never claim tests passed without executing them.

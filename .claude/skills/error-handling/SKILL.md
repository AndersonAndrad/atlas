---
name: error-handling
description: Reviews application error handling, failure propagation, external dependency failures, timeouts, retries, user-facing errors, logs, and recovery behavior. Use whenever code can fail or communicates with another component.
---

# Error Handling

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

Expected failures must be handled deliberately.

Apply `../security-log/SKILL.md` to decide what affected error responses may
expose externally and what remains in internal logs.

## Failure identification

Identify failures from:

- Invalid input
- Missing resources
- Unauthorized operations
- Forbidden operations
- Conflicts
- Persistence failures
- External API failures
- Timeouts
- Network failures
- Parsing failures
- Concurrency
- Duplicate execution
- Internal programming errors

## Error behavior

Verify that each failure:

- Produces the correct error category
- Preserves useful diagnostic context
- Does not expose internal implementation details
- Does not leak secrets or sensitive data
- Uses the project's standard error format
- Is logged at the appropriate level
- Does not leave partial state unexpectedly

## External services

For external calls, consider:

- Explicit timeout
- Retry policy
- Retryable versus non-retryable errors
- Backoff
- Circuit breaking when applicable
- Idempotency
- Duplicate responses
- Malformed responses
- Partial success
- Provider-specific error mapping

Never retry an operation blindly when repetition can create duplicate effects.

## Logging

Logs should contain enough context to investigate the problem without exposing
sensitive information.

Prefer structured fields such as:

- Operation
- Resource identifier
- Correlation identifier
- Error category
- External provider
- Attempt count
- Duration

Do not log complete request or response objects unless they are explicitly
sanitized.

## Catch blocks

Every catch block must do at least one meaningful action:

- Convert the error
- Add context
- Recover safely
- Perform cleanup
- Record a useful log
- Re-throw intentionally

Do not swallow errors silently.
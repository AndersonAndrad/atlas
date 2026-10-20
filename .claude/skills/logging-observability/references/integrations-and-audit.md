# Integration and audit signals

Use for external providers, retries, queues, webhooks, persistence,
transactions, caching, authentication, authorization, and business audit logs.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 21. External integrations

For external provider calls, record:

* Provider
* Operation
* Start time
* Duration
* Result category
* HTTP status
* Provider business status
* Provider request ID
* Internal correlation ID
* Retry count
* Timeout
* Circuit breaker state when applicable

Do not assume HTTP success means business success.

Example:

```json
{
  "event": "provider_request_completed",
  "provider": "fitbank",
  "operation": "create_account",
  "httpStatus": 200,
  "businessSuccess": false,
  "providerCode": "ISE0014",
  "durationMs": 824,
  "correlationId": "corr-123"
}
```

Do not log the complete provider payload unless it is explicitly sanitized.

## 22. Provider error mapping

Map provider-specific failures into stable internal categories.

Example:

```text
Provider code: ISE0014
Internal category: provider_validation_failed
```

Preserve the provider code as a field when safe.

This allows:

* Provider-specific investigation
* Stable internal dashboards
* Better user-facing messages
* Easier migration between providers

Do not expose raw provider errors directly to users unless they are safe and
understandable.

## 23. Retries

Every retry decision should be observable.

Record:

* Operation
* Attempt number
* Maximum attempts
* Retry reason
* Delay
* Whether the error is retryable
* Provider or dependency
* Idempotency protection
* Final outcome

Example:

```json
{
  "event": "provider_retry_scheduled",
  "provider": "fitbank",
  "operation": "create_transfer",
  "attempt": 2,
  "maxAttempts": 3,
  "retryReason": "provider_timeout",
  "delayMs": 1000,
  "idempotencyKeyPresent": true
}
```

Do not log retries as errors when recovery is expected.

Log the final exhausted retry as an error.

## 24. Queues and background jobs

For queues and jobs, record:

* Job ID
* Message ID
* Event ID
* Queue name
* Operation
* Attempt
* Maximum attempts
* Processing start
* Processing completion
* Duration
* Duplicate detection
* Retry
* Dead-letter routing
* Correlation ID
* Result category

Important events:

```text
job_received
job_processing_started
job_completed
job_failed
job_retry_scheduled
job_duplicate_ignored
job_moved_to_dead_letter
```

Do not log the full message payload by default.

## 25. Webhooks

For webhooks, record:

* Provider
* Event type
* Provider event ID
* Internal correlation ID
* Signature validation result
* Duplicate detection
* Processing result
* Duration
* Retry or redelivery information

Do not log:

* Full signature
* Complete payload
* Secrets
* Sensitive personal or financial data

A webhook should be traceable even when delivered multiple times.

## 26. Database operations

Do not log every database query in production by default.

Log or trace:

* Slow queries
* Failed operations
* Constraint violations
* Timeouts
* Transaction rollback
* Deadlocks
* Retry decisions
* Unexpected record counts
* Data consistency failures

Include:

* Operation type
* Entity or collection
* Duration
* Result category
* Safe resource identifiers
* Correlation ID

Do not log raw queries containing sensitive values.

## 27. Transactions

For important transactional operations, make observable:

* Transaction started
* Transaction committed
* Transaction rolled back
* Rollback reason
* Compensating action
* Partial external side effect
* Recovery decision

Do not log normal internal transaction details excessively.

Focus on outcomes that affect data integrity.

## 28. Cache observability

Record when relevant:

* Cache hit
* Cache miss
* Cache fallback
* Cache invalidation
* Cache error
* Stale value detected
* Cache stampede protection
* Serialization failure

Avoid info-level logging for every cache hit in high-volume systems.

Use metrics for aggregate cache behavior.

Useful metrics:

```text
cache_hits_total
cache_misses_total
cache_errors_total
cache_operation_duration_ms
```

## 29. Authentication observability

Record authentication events carefully.

Possible events:

```text
authentication_succeeded
authentication_failed
token_expired
token_revoked
session_terminated
password_reset_requested
password_reset_completed
mfa_challenge_failed
```

Avoid exposing:

* Whether a specific email exists
* Password content
* Token content
* OTP codes
* Internal security rules

Use safe identifiers and rate-limit relevant events.

Authentication failure logs should support detecting brute-force attempts
without enabling user enumeration.

## 30. Authorization observability

Record important authorization failures when useful.

Include:

* Principal ID
* Resource type
* Operation
* Permission category
* Tenant ID
* Correlation ID
* Result

Avoid logging unnecessary sensitive resource details.

Differentiate:

* Unauthenticated
* Authenticated but unauthorized
* Resource ownership violation
* Tenant boundary violation
* Administrative policy denial

## 31. Audit logs

Audit logs are different from application logs.

Application logs answer:

> Why did the system fail?

Audit logs answer:

> Who did what, to which resource, and when?

Audit events may include:

* User created
* User disabled
* Permission changed
* Payment approved
* Refund executed
* Sensitive data accessed
* Configuration changed
* Credential generated
* Resource deleted
* Administrative action performed

An audit record should include:

* Actor
* Action
* Resource
* Timestamp
* Result
* Source
* Correlation ID
* Relevant before and after values when safe and required

Do not place secrets or complete sensitive payloads in audit logs.

Audit records may require stronger retention and access controls.

## 32. Before and after values

When auditing changes, do not blindly store complete objects.

Prefer explicit relevant fields.

Example:

```json
{
  "event": "user_role_changed",
  "userId": "user-123",
  "previousRole": "user",
  "newRole": "admin",
  "changedBy": "admin-456"
}
```

Avoid:

```json
{
  "before": { "completeUserObject": "..." },
  "after": { "completeUserObject": "..." }
}
```

Complete objects may contain sensitive or irrelevant data.

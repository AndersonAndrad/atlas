# Operational signals and cost

Use for frontend signals, sampling, cost, health checks, alerts, dashboards,
feature flags, deployment observability, retention, and failure scenarios.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 33. Frontend observability

Frontend monitoring may include:

* Page load failures
* API request failures
* Unhandled exceptions
* Failed form submission
* Critical user flow abandonment
* Performance metrics
* Resource loading failures
* Feature availability

Avoid recording:

* Passwords
* Full form contents
* Tokens
* Complete URLs with sensitive query parameters
* Sensitive DOM content
* User keystrokes

Do not add analytics to sensitive actions without explicit product and privacy
requirements.

## 34. User-facing error references

For unexpected errors, the interface may show a safe reference.

Example:

```text
Não foi possível concluir a operação.
Código de referência: 8F2K-19A
```

The reference should map to:

* Correlation ID
* Error ID
* Trace ID
* Incident lookup identifier

Do not expose:

* Stack trace
* Database error
* Provider credentials
* Internal architecture
* Sensitive resource IDs

## 35. Sampling

High-volume logs and traces may require sampling.

Consider sampling for:

* Successful repetitive requests
* Health checks
* Cache hits
* Polling
* High-frequency background jobs
* Repeated expected validation errors

Do not aggressively sample:

* Errors
* Security events
* Financial operations
* Rare failures
* Critical state transitions
* Audit events

Sampling must not make important incidents impossible to investigate.

## 36. Log volume and cost

Review whether the implementation may create excessive telemetry.

Risks include:

* Logging inside large loops
* Logging every item in a batch
* Logging complete payloads
* Logging repeated retries
* Duplicate logs across layers
* Large stack traces for expected errors
* High-cardinality metric labels
* Debug logs enabled in production

Prefer aggregated logs.

Example:

```json
{
  "event": "batch_processing_completed",
  "total": 1000,
  "succeeded": 980,
  "failed": 20
}
```

Instead of one info log per item.

Log individual failures when investigation requires it.

## 37. Health checks

Health checks should distinguish:

* Process alive
* Application ready
* Critical dependency available
* Optional dependency degraded

Common categories:

### Liveness

Is the process running?

### Readiness

Can the application safely receive traffic?

### Dependency health

Are required dependencies working?

Do not make liveness fail because an optional provider is unavailable.

Avoid placing sensitive infrastructure details in public health responses.

## 38. Alerts

Alerts should represent actionable conditions.

Good alert candidates:

* Sustained error rate increase
* High provider timeout rate
* Queue backlog growth
* Dead-letter messages
* Database saturation
* Authentication abuse
* Repeated transaction rollback
* Payment inconsistency
* Missing scheduled processing
* Service unavailable
* Significant latency degradation

Avoid alerts for:

* Single expected validation failure
* One transient retry
* Normal cache miss
* Routine user error

An alert should answer:

* What happened?
* Why does it matter?
* Which service or flow is affected?
* What should the responder inspect first?

## 39. Dashboards

For relevant features, identify whether dashboards should include:

* Request volume
* Success rate
* Failure rate
* Latency
* Error categories
* Provider behavior
* Retry count
* Queue depth
* Processing duration
* Duplicate operations
* User-facing failures
* Business outcome counts

Do not create dashboards automatically for trivial changes.

Recommend them when the feature is operationally important.

## 40. Feature flags and rollout

When a feature uses a flag, record when useful:

* Flag name
* Evaluated result
* Variation
* Rollout cohort
* Fallback behavior
* Evaluation failure

Do not log user-sensitive targeting data unnecessarily.

During rollout, observability should allow comparison between:

* Enabled and disabled populations
* Old and new behavior
* Success and failure rates
* Performance differences

## 41. Deployment observability

For risky changes, consider whether telemetry can identify:

* Deployment version
* Commit hash
* Build version
* Environment
* Region
* Instance
* Feature flag state

This supports comparison before and after deployment.

Do not log build metadata in every custom event when it is already attached
automatically by the platform.

## 42. Data retention

Telemetry should have an intentional retention policy.

Consider:

* Application logs
* Security logs
* Audit logs
* Metrics
* Traces
* Provider payload archives
* Error events

Retention depends on:

* Operational needs
* Cost
* Privacy
* Compliance
* Investigation window
* Legal requirements

Do not retain sensitive data indefinitely merely because storage is available.

## 43. Failure scenarios to review

For every relevant operation, consider:

* Validation failure
* Authentication failure
* Authorization failure
* Resource not found
* Conflict
* Database timeout
* Database constraint violation
* External provider timeout
* Provider business rejection
* Provider malformed response
* Duplicate execution
* Retry exhaustion
* Queue redelivery
* Partial completion
* Unexpected exception
* Rollback failure
* Compensating action failure

For each scenario, determine:

* Log event
* Level
* Fields
* Metric
* Trace behavior
* Alert relevance
* User-facing reference
* Redaction needs

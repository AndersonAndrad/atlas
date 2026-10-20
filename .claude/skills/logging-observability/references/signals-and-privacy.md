# Signal design and privacy

Use for structured logging, levels, correlation, safe identifiers, redaction,
request/response/error handling, metrics/cardinality, and tracing.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 3. Structured logging

Prefer structured logs over concatenated text.

Good:

```json
{
  "event": "payment_processing_failed",
  "operation": "process_payment",
  "orderId": "order-123",
  "provider": "payment-provider",
  "errorCategory": "provider_timeout",
  "correlationId": "corr-456",
  "durationMs": 3200
}
```

Avoid:

```text
Payment failed for order order-123 because provider timed out after 3200ms
```

Structured fields improve:

* Filtering
* Aggregation
* Dashboards
* Alerts
* Correlation
* Automated analysis
* Incident investigation

Use stable field names across the project.

## 4. Event naming

Use clear and consistent event names.

Prefer a predictable format such as:

```text
resource_action_result
```

Examples:

```text
user_created
user_creation_failed
payment_processing_started
payment_processing_completed
payment_processing_failed
webhook_duplicate_ignored
authentication_failed
inventory_reservation_conflict
```

Avoid vague events such as:

```text
error
something_failed
request_problem
service_issue
```

Event names should communicate:

* What happened
* To which domain
* At which stage
* With which outcome

## 5. Log levels

Use log levels intentionally.

### Trace

Use for extremely detailed diagnostic information.

Usually disabled in production.

Examples:

* Internal decision branches
* Low-level protocol details
* Detailed flow tracing

Do not log sensitive payloads even at trace level.

### Debug

Use for development and temporary diagnostics.

Examples:

* Internal state transitions
* Cache decisions
* Non-sensitive request metadata
* Adapter behavior
* Feature flag evaluation

Debug logs should not be required for normal production monitoring.

### Info

Use for meaningful successful business or operational events.

Examples:

* Service started
* User creation completed
* Payment processed
* Job completed
* Integration authenticated
* State transition completed

Do not log every internal function call as info.

### Warn

Use when something unexpected happened but the operation may continue or recover.

Examples:

* Retry scheduled
* Deprecated field received
* Rate limit approaching
* Cache unavailable with database fallback
* Duplicate request ignored
* Optional provider unavailable
* Unexpected but handled state

Warnings should indicate a condition that deserves attention.

### Error

Use when an operation failed and requires investigation.

Examples:

* Business operation failed unexpectedly
* Database operation failed
* External provider failed after retries
* Message moved to dead-letter queue
* Unhandled exception
* Persistent inconsistency detected

Do not use error for expected validation failures unless project policy
explicitly requires it.

### Fatal

Use only when the process or service cannot safely continue.

Examples:

* Required configuration missing
* Database unavailable at startup
* Critical dependency initialization failed
* Corrupted application state

Do not use fatal for a failed individual request.

## 6. Avoid log level inflation

Incorrect log levels cause:

* Alert fatigue
* Increased costs
* Hidden real incidents
* Misleading dashboards
* Difficult investigation

Examples:

A user entering an invalid email is normally not an error-level event.

A provider timing out after all retries may be an error.

A first failed attempt followed by a successful retry may be a warning or debug,
depending on project policy.

A duplicated webhook safely ignored may be info or warning, not necessarily
an error.

Choose the level based on operational impact.

## 7. Correlation identifiers

Preserve correlation across the complete flow.

Possible identifiers include:

* Correlation ID
* Request ID
* Trace ID
* Span ID
* Operation ID
* Job ID
* Message ID
* Event ID
* External provider request ID
* Idempotency key

When receiving an existing identifier:

* Validate its format if necessary.
* Preserve it.
* Propagate it to downstream calls.
* Include it in relevant logs.
* Return it in responses when project conventions allow.

When none exists:

* Generate one at the system boundary.
* Reuse the same value throughout the operation.

Do not generate a new correlation identifier at every internal layer.

## 8. Business identifiers

Include identifiers that help locate the affected resource.

Examples:

* User ID
* Account ID
* Order ID
* Payment ID
* Transaction ID
* Organization ID
* Tenant ID
* Job ID
* Webhook event ID
* External protocol
* Provider operation ID

Prefer internal stable identifiers.

Be careful with:

* Email
* CPF
* CNPJ
* Telephone
* Full name
* Address
* Card information
* Bank information

Use these only when necessary and allowed by project policy.

Prefer masked, hashed, or indirect identifiers.

## 9. Sensitive data

Never log:

* Passwords
* Password hashes
* Access tokens
* Refresh tokens
* API keys
* Private keys
* Authentication cookies
* Session tokens
* OTP codes
* Verification codes
* Cryptographic signatures
* Full authorization headers
* Database connection strings
* Secrets from environment variables
* Full card numbers
* CVV
* Full bank credentials
* Complete biometric data
* Sensitive documents
* Private file contents

Do not log full request and response objects by default.

Objects may contain sensitive nested fields.

## 10. Personally identifiable information

Treat personal data carefully.

Examples:

* Name
* Email
* CPF
* CNPJ when linked to individuals
* Telephone
* Address
* Date of birth
* Location
* IP address
* Device identifier
* Financial information
* Documents

Before logging personal data, ask:

* Is it necessary for investigation?
* Can an internal identifier replace it?
* Can it be masked?
* Can it be hashed?
* Can only part of it be logged?
* What is the retention period?
* Who can access the logs?

Examples of masking:

```text
Email: a***@example.com
CPF: ***.***.***-12
Telephone: ******7890
Card: **** **** **** 1234
```

Do not assume hashing always anonymizes data.

Low-entropy values may still be reversible through guessing.

## 11. Redaction

Use centralized redaction where possible.

Common fields to redact:

```text
password
passwordConfirmation
token
accessToken
refreshToken
authorization
cookie
apiKey
secret
privateKey
otp
verificationCode
signature
clientSecret
connectionString
```

Redaction should work recursively.

Verify:

* Nested objects
* Arrays
* Request headers
* Query parameters
* Error metadata
* Provider payloads
* Serialized objects
* Exception causes

Do not depend only on developers remembering to omit fields manually.

## 12. Request logging

Request logs may include:

* HTTP method
* Route template
* Status code
* Duration
* Request ID
* Correlation ID
* Authenticated principal ID
* Tenant ID
* User agent category
* Response size
* Error category

Prefer route templates:

```text
/users/:id
```

instead of full paths containing identifiers:

```text
/users/123456
```

Avoid logging:

* Complete body
* Complete query string
* Authorization headers
* Cookies
* Multipart file content
* Raw personal data
* Raw provider responses

## 13. Response logging

Do not log complete responses by default.

Instead log:

* Result category
* Status code
* Business outcome
* Resource ID
* Record count
* Duration
* Error category
* Provider status category

Example:

```json
{
  "event": "account_creation_completed",
  "accountId": "acc-123",
  "status": "created",
  "durationMs": 418
}
```

Avoid:

```json
{
  "event": "account_creation_completed",
  "response": {
    "name": "Full Name",
    "document": "00000000000",
    "address": {},
    "token": "secret"
  }
}
```

## 14. Error logging

An error log should contain enough context to investigate the failure.

Include when applicable:

* Event
* Operation
* Error category
* Error code
* Internal error type
* Safe error message
* Resource identifiers
* Correlation ID
* Provider
* Provider request ID
* Attempt number
* Duration
* Retry decision
* Stack trace for unexpected errors

Do not expose stack traces to end users.

Do not duplicate the same error at every layer.

## 15. Avoid duplicate logging

A common anti-pattern is logging and rethrowing the same error in every layer.

Example:

```text
Controller logs error
Service logs same error
Repository logs same error
Global handler logs same error
```

This produces four logs for one failure.

Prefer:

* Lower layer adds context to the error.
* Boundary or global handler records the final failure.
* Specific layers log only when they make a meaningful decision.

Meaningful decisions include:

* Retry scheduled
* Fallback activated
* Error transformed
* Partial recovery completed
* Duplicate ignored
* Compensating action executed

## 16. Error categories

Create stable error categories that support dashboards and alerts.

Examples:

```text
validation_failed
authentication_failed
authorization_failed
resource_not_found
resource_conflict
database_timeout
database_constraint_violation
provider_timeout
provider_rejected
provider_unavailable
rate_limited
duplicate_operation
internal_error
```

Do not use raw exception messages as metric labels or categories.

Exception messages may contain:

* Dynamic identifiers
* Sensitive data
* High cardinality
* Implementation details

## 17. Metrics

Use metrics for aggregate behavior.

Common metric types:

### Counter

Use for events that accumulate.

Examples:

```text
requests_total
payments_processed_total
payments_failed_total
webhooks_received_total
duplicate_operations_total
authentication_failures_total
```

### Gauge

Use for values that increase and decrease.

Examples:

```text
queue_depth
active_connections
open_orders
running_jobs
available_workers
```

### Histogram or timer

Use for distributions and duration.

Examples:

```text
request_duration_ms
provider_duration_ms
database_query_duration_ms
job_processing_duration_ms
payload_size_bytes
```

Do not use logs as a replacement for every metric.

Do not create a metric for every minor internal event.

## 18. Metric labels

Metric labels must have controlled cardinality.

Usually safe labels:

* Environment
* Service
* Route template
* HTTP method
* Status category
* Provider
* Operation
* Error category
* Queue name
* Result

Dangerous high-cardinality labels:

* User ID
* Request ID
* Transaction ID
* Email
* Full URL
* Exception message
* Timestamp
* Free-form text
* Payload content

High-cardinality labels can make monitoring expensive and unstable.

Identifiers belong in logs and traces, not usually in metric labels.

## 19. Tracing

Use distributed tracing when a request crosses:

* Multiple services
* Databases
* Queues
* External providers
* Background workers
* Serverless functions

A trace should reveal:

* Entry point
* Internal steps
* Database calls
* External calls
* Queue publication
* Queue consumption
* Duration of each stage
* Failure location

Propagate trace context through:

* HTTP headers
* Message metadata
* Queue attributes
* Background job context
* Scheduled processing

Do not include sensitive payloads in span attributes.

## 20. Spans

Create spans around meaningful operations.

Examples:

```text
database.user.find
database.payment.create
provider.fitbank.execute
queue.payment.publish
queue.payment.consume
business.order.finalize
```

Avoid spans around trivial local functions.

Add safe attributes such as:

* Operation
* Provider
* Resource type
* Result category
* Retry count
* Status
* Tenant ID when policy permits

Avoid high-cardinality or sensitive attributes.

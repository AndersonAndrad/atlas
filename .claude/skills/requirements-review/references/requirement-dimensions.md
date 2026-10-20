# Requirement dimensions

Use for actors, permissions, inputs, state, errors, idempotency, concurrency,
data, contracts, UI, security, integrations, and observability. Do not invent
requirements or require every category for a small change.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 4. Identify actors and permissions

Determine:

* Who performs the action?
* Which roles can perform it?
* Which resources can they access?
* Can users act on resources owned by others?
* Is administrative access different?
* Does the operation require authentication?
* Does it require additional authorization?
* Can the action be performed by automated processes?
* Can an integration or webhook execute the same behavior?

Authentication and authorization must be treated as separate requirements.

## 5. Identify the complete flow

Map the affected flow when applicable:

1. User interaction
2. Frontend validation
3. Request contract
4. Authentication
5. Authorization
6. Input normalization
7. Business validation
8. Business operation
9. Persistence
10. External integration
11. Error handling
12. Logging and tracing
13. Response
14. User feedback
15. Tests
16. Documentation
17. Monitoring

Do not review only the layer explicitly mentioned in the task.

## 6. Clarify input behavior

For each relevant input, determine:

* Is it required?
* Can it be empty?
* Can it be null?
* Can it contain only whitespace?
* What is the minimum length?
* What is the maximum length?
* Which format is accepted?
* Is casing meaningful?
* Are leading or trailing spaces meaningful?
* Are internal spaces meaningful?
* Can the value contain Unicode?
* Can the value contain emojis?
* Can the value contain line breaks?
* Can the value be pasted with formatting?
* Should the value be normalized?
* Should invalid values be rejected or transformed?

Do not normalize values blindly.

Be especially careful with:

* Passwords
* Tokens
* API keys
* Cryptographic signatures
* Hashes
* Encoded values
* Verification codes
* Free-form text
* File content
* External identifiers
* Values compared byte-for-byte

If surrounding spaces are prohibited in a sensitive value, prefer explicit
validation over silent mutation.

## 7. Clarify state transitions

For workflows involving status or lifecycle changes, identify:

* Initial state
* Allowed next states
* Forbidden transitions
* Final states
* Reversible states
* Who can change the state
* Preconditions
* Side effects
* Retry behavior
* Duplicate execution behavior
* Audit requirements

Examples include:

* Order status
* Payment status
* Account onboarding
* Approval
* Cancellation
* Refund
* Delivery
* User activation
* Document processing

Do not allow arbitrary state changes without validating the transition.

## 8. Clarify error behavior

Determine what should happen when:

* Input is invalid
* Authentication fails
* Authorization fails
* The resource does not exist
* The resource already exists
* The current state does not permit the action
* Persistence fails
* An external service times out
* An external service rejects the request
* A duplicate request is received
* A partial operation succeeds
* The client retries
* The operation is interrupted

For each expected failure, identify:

* Error category
* User-facing message
* Internal diagnostic context
* Whether retry is allowed
* Whether rollback is needed
* Whether the failure must be logged
* Whether monitoring or alerting is needed

## 9. Clarify idempotency and concurrency

Ask whether the operation can happen more than once.

Review:

* Double-clicks
* Client retries
* Network timeouts
* Queue redelivery
* Webhook redelivery
* Concurrent requests
* Scheduled reprocessing
* Multiple application instances
* Read-modify-write operations
* Duplicate external responses

Determine:

* Whether duplicate execution is acceptable
* Whether an idempotency key is required
* Whether a unique constraint is needed
* Whether a transaction is needed
* Whether optimistic or pessimistic locking is needed
* Whether an existing operation must be checked before retrying

Do not assume that retries are harmless.

## 10. Clarify data behavior

Determine:

* Which data is created
* Which data is updated
* Which data is removed
* Which fields are immutable
* Which fields are optional
* Which values must remain historically accurate
* Whether audit history is required
* Whether soft delete or hard delete applies
* Whether existing records require migration
* Whether older data remains compatible
* Whether partial updates are allowed
* Whether database constraints enforce the rule

Consider what happens to existing records after the change.

## 11. Clarify public contracts

Identify whether the task changes:

* HTTP endpoints
* Request body
* Response body
* Status codes
* Headers
* Error format
* Events
* Queue messages
* Webhooks
* Database schema
* Shared types
* SDK behavior
* Configuration
* Environment variables
* Command-line interfaces

For every public contract change, identify:

* Current consumers
* Compatibility risk
* Versioning requirements
* Migration strategy
* Deprecation strategy
* Documentation changes
* Tests required

Do not silently change a public contract.

## 12. Clarify frontend experience

When the task affects the interface, determine:

* What the user sees before the action
* What the user sees during loading
* What happens on success
* What happens on failure
* Whether duplicate submission must be prevented
* Whether fields retain their values after failure
* Whether validation is inline or on submission
* Whether the flow works with keyboard navigation
* Whether mobile behavior differs
* Whether empty states are required
* Whether permissions change the available actions
* Whether destructive actions require confirmation
* Whether undo is possible

Do not consider the frontend requirement complete only because the component
renders.

## 13. Clarify security and privacy

Determine whether the flow handles:

* Credentials
* Tokens
* Personal data
* Financial data
* Documents
* Files
* Internal identifiers
* Location
* Authentication data
* Authorization rules
* Administrative actions
* Audit records

Identify:

* Who can access the data
* What can be logged
* What must be redacted
* Retention requirements
* Encryption requirements
* Rate limiting needs
* Abuse scenarios
* Enumeration risks
* Exposure through errors
* Exposure through frontend state

Do not log complete request or response objects without confirming that they
contain no sensitive information.

## 14. Clarify integrations

For external services, identify:

* Provider
* Operation
* Timeout
* Retry policy
* Rate limits
* Idempotency support
* Authentication method
* Error formats
* Partial success behavior
* Webhook behavior
* Duplicate notifications
* Sandbox differences
* Production differences
* Fallback behavior
* Required observability

Do not assume that a timeout means the provider did not process the request.

## 15. Clarify observability

Determine how the feature will be investigated in production.

Consider:

* Structured logs
* Correlation ID
* Request ID
* Operation ID
* External provider identifiers
* Metrics
* Tracing
* Error categorization
* Dashboards
* Alerts
* Audit trail

Observability should support real operational questions, such as:

* How many requests failed?
* Which step failed?
* Was the provider called?
* Was the operation retried?
* Was a duplicate prevented?
* Which user or resource was affected?
* How long did the operation take?

Avoid logging sensitive payloads merely to improve diagnostics.

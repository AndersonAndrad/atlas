# State and integration edge cases

Use for state transitions, duplicates, concurrency, persistence, caches,
external providers, queues, jobs, files, and uploads.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 13. State transitions

For workflows with statuses, test:

* Valid transition
* Repeated transition
* Transition from the wrong state
* Skipping states
* Returning to a previous state
* Transition after final state
* Concurrent transitions
* Transition during external processing
* Transition after timeout
* Transition after cancellation
* Partial side effects
* Manual and automated transitions occurring together

Represent allowed transitions explicitly when the workflow is important.

Do not rely only on scattered conditional statements.

## 14. Duplicate execution

Assume the same operation may happen more than once because of:

* Double-click
* Network retry
* Client retry
* Queue redelivery
* Webhook redelivery
* Timeout
* User refreshing the page
* Multiple application instances
* Scheduled retry
* Provider callback duplication

Verify:

* Whether the operation is idempotent
* Whether a unique key exists
* Whether duplicate state is detected
* Whether duplicate side effects are prevented
* Whether the same response can be safely returned
* Whether duplicate execution is logged

Critical examples include:

* Payment
* Refund
* Transfer
* Sending messages
* Creating users
* Generating credentials
* Inventory deduction
* Applying discounts
* External provider calls

## 15. Concurrency

Consider two or more operations happening at nearly the same time.

Examples:

* Two users updating the same record
* Two payments for the same order
* Two stock reservations
* Two password reset attempts
* Two workers processing the same message
* Two requests using the same limited resource
* One operation reading while another deletes
* One operation validating while another changes the state

Look for:

* Lost updates
* Dirty reads
* Duplicate records
* Negative inventory
* Double processing
* Inconsistent totals
* Invalid state transitions
* Check-then-act race conditions

Potential protections include:

* Unique constraints
* Atomic updates
* Transactions
* Optimistic locking
* Pessimistic locking
* Idempotency keys
* Compare-and-set operations
* Distributed locks

Do not add locking without identifying the real race condition.

## 16. Persistence

Review:

* Record not found
* Duplicate record
* Constraint violation
* Partial update
* Failed transaction
* Connection failure
* Timeout
* Old schema data
* Missing optional fields
* Corrupted legacy data
* Soft-deleted records
* Concurrent update
* Rollback behavior
* Read-after-write consistency

Verify whether business rules are also protected by database constraints when
appropriate.

Application checks alone may not prevent concurrent duplicates.

## 17. Cache behavior

Consider:

* Cache miss
* Stale cache
* Expired cache
* Cache unavailable
* Corrupted cached value
* Different serialization versions
* Invalidation failure
* Cache updated before persistence
* Persistence updated without cache invalidation
* Concurrent cache population
* Cache stampede
* Tenant key collision
* User key collision

The system should remain correct when cache is unavailable unless the cache is
explicitly authoritative.

## 18. External integrations

Review:

* Timeout before response
* Timeout after provider processing
* Connection failure
* Provider unavailable
* Rate limit
* Invalid credentials
* Expired credentials
* Malformed provider response
* Missing expected field
* Additional unexpected fields
* Partial success
* Duplicate response
* Out-of-order callback
* Delayed webhook
* Webhook before synchronous response
* Sandbox and production differences
* Provider returning HTTP success with business failure
* Retry causing duplicate side effects

Do not assume HTTP 200 means business success.

Do not assume timeout means the provider did not process the request.

## 19. Background jobs and queues

Consider:

* Message delivered twice
* Message delivered out of order
* Consumer crashes after processing but before acknowledgment
* Consumer crashes before processing
* Poison message
* Maximum retry reached
* Dead-letter queue
* Missing correlation identifier
* Long-running processing
* Worker restarted
* Schema version mismatch
* Partial processing
* Dependency outage
* Concurrent consumers

Verify that processing is idempotent when duplicate delivery is possible.

## 20. Files and uploads

Review:

* Empty file
* Missing file
* Oversized file
* Wrong extension
* Correct extension with invalid content
* Incorrect MIME type
* Multiple extensions
* Path traversal
* Duplicate filename
* Unicode filename
* Long filename
* Executable content
* Corrupted file
* Partial upload
* Upload interrupted
* Unsupported encoding
* Malicious archive
* Archive expansion size
* Metadata containing sensitive information

Do not trust extension or MIME type alone.

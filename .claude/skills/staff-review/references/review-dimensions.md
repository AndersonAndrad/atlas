# Review dimensions

Assess architecture, security, performance, maintainability, readability, naming,
complexity, correctness, bugs, regressions, tests, production impact, observability,
dependencies, backward compatibility, deployment, and rollback. Read every
applicable dimension and record reasons for non-applicability internally.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 3. Architecture

Review:

* Responsibility boundaries
* Separation of concerns
* Layering
* Domain leakage
* Infrastructure leakage
* Coupling
* Cohesion
* Dependency direction
* Abstraction quality
* Module boundaries
* Service boundaries
* Reuse versus duplication
* Provider-specific code
* Public contract placement
* State ownership
* Side-effect ownership
* Error ownership
* Transaction boundaries

Ask:

* Is the rule implemented in the correct layer?
* Does the change create unnecessary coupling?
* Does a low-level module know too much about business behavior?
* Does provider-specific behavior leak into the domain?
* Is an abstraction hiding complexity or merely moving it?
* Is the solution unnecessarily generic?
* Is important behavior distributed across unrelated files?
* Could this design make future changes harder?

Do not recommend architecture changes merely for stylistic preference.

Report only changes with practical impact.

## 4. Security

Review:

* Authentication
* Authorization
* Tenant isolation
* Resource ownership
* Input validation
* Output exposure
* Injection risks
* XSS
* SSRF
* Path traversal
* Unsafe redirects
* Deserialization
* File handling
* Secret management
* Token handling
* Cryptographic verification
* Replay attacks
* Brute-force protection
* Rate limiting
* Sensitive logging
* Personal data exposure
* Mass assignment
* Privilege escalation
* Insecure defaults

Check both direct and indirect access paths.

Do not assume authorization is safe because the frontend hides an action.

Do not assume a token is valid merely because it can be decoded.

## 5. Performance

Review:

* N+1 operations
* Repeated network calls
* Repeated database calls
* Unbounded loops
* Unbounded collections
* Large payloads
* Expensive serialization
* Blocking operations
* Synchronous work in critical paths
* Unnecessary re-renders
* Inefficient state updates
* Missing pagination
* Missing indexes
* Excessive memory use
* Cold-start impact
* Bundle impact
* Cache misuse
* Repeated parsing or transformation
* Excessive logging
* High-cardinality metrics

Distinguish actual risks from theoretical micro-optimizations.

Do not report minor performance preferences without measurable or likely
production impact.

## 6. Maintainability

Review:

* Responsibility clarity
* Function size
* Module size
* Naming
* Hidden behavior
* Implicit contracts
* Duplicated rules
* Magic values
* Hard-coded business rules
* Excessive branching
* Fragile conditionals
* Temporal coupling
* Configuration spread
* Testability
* Dependency isolation
* Documentation needs
* Future change cost

Ask:

* Can another engineer safely change this in six months?
* Is the business rule visible?
* Is the implementation relying on undocumented assumptions?
* Will a small change require editing many unrelated places?
* Does the code make invalid states easy to represent?
* Does the implementation expose too many internal details?

## 7. Readability and naming

Names must communicate intent without requiring the reader to inspect distant
context.

Review:

* Single-letter variables
* Unnecessary abbreviations
* Generic names
* Misleading names
* Names that describe type instead of purpose
* Names that no longer match behavior
* Boolean names without clear polarity
* Functions that hide side effects
* Functions with vague verbs
* Parameters whose meaning requires inspecting their types

Prefer:

```ts
const loadAuditList = async (
    filter: FitbankWebhookAuditFilter,
) => {};
```

Avoid:

```ts
const loadList = async (
    f: FitbankWebhookAuditFilter,
) => {};
```

Avoid names such as:

```text
f
d
obj
arr
tmp
val
data
info
result
item
```

when a specific domain name is available.

Established abbreviations such as `id`, `url`, `api`, `http`, and project-wide
terms may be accepted.

The goal is not longer names.

The goal is immediate comprehension with minimal cognitive effort.

## 8. Complexity

Review:

* Nested conditions
* Excessive branching
* Repeated boolean expressions
* Large functions
* Excessive parameters
* Hidden state
* Multiple responsibilities
* Complex generic types
* Complex inheritance
* Excessive indirection
* Premature abstractions
* Clever code
* Repeated transformations
* Difficult control flow

Ask:

* Can the implementation be understood from top to bottom?
* Are branches mutually exclusive and complete?
* Are invalid states explicit?
* Is complexity inherent to the domain or introduced by the solution?
* Could a simpler implementation preserve the same behavior?

Do not recommend extracting functions merely to reduce line count.

Extraction must improve meaning, reuse, testing, or responsibility boundaries.

## 9. Correctness and possible bugs

Actively attempt to prove the implementation wrong.

Review:

* Incorrect conditions
* Inverted conditions
* Missing branches
* Incorrect defaults
* Null and undefined behavior
* Empty values
* Boundary values
* Incorrect transformations
* Stale state
* Incorrect asynchronous behavior
* Missing await
* Swallowed errors
* Incorrect error propagation
* Incorrect state transition
* Incorrect query filters
* Partial updates
* Duplicate execution
* Race conditions
* Transaction boundaries
* Timezone behavior
* Floating-point behavior
* Incorrect type assumptions
* Incorrect provider response interpretation
* Incorrect success criteria

Do not trust tests as proof that every behavior is correct.

Tests may encode the same incorrect assumption as the implementation.

## 10. Regressions

Identify behavior that may have been unintentionally changed.

Review:

* Existing consumers
* Existing API clients
* Old records
* Optional fields
* Default behavior
* Error formats
* Status codes
* Ordering
* Pagination
* Caching
* Authentication behavior
* Authorization behavior
* Existing UI state
* Existing event payloads
* Existing queue messages
* Existing integrations
* Existing configuration
* Rolling deployment compatibility

Search for all usages of changed contracts, types, functions, and fields.

Do not assume all services and clients deploy simultaneously.

## 11. Tests

Evaluate whether tests prove the behavior rather than merely execute the code.

Review:

* Happy path
* Failure paths
* Invalid input
* Boundary values
* Permissions
* Ownership
* Duplicate execution
* Concurrency
* External timeouts
* Provider rejection
* Database failure
* Partial failure
* Existing-data behavior
* Backward compatibility
* Regression coverage
* State transitions
* Error mapping
* Sensitive data redaction

Check whether tests:

* Assert meaningful outcomes
* Could pass while behavior remains wrong
* Mock too much
* Reproduce production behavior
* Cover the actual regression
* Are deterministic
* Verify side effects
* Verify absence of forbidden side effects

Do not consider line coverage sufficient evidence.

## 12. Production impact

Review what happens after deployment.

Consider:

* Database migrations
* Existing data
* Rolling deployment
* Mixed application versions
* Cache compatibility
* Queue backlog
* Old queue messages
* External provider behavior
* Rate limits
* Timeouts
* Retry amplification
* Log volume
* Metric cardinality
* Deployment configuration
* Environment variables
* Resource consumption
* Failure recovery
* Rollback
* Monitoring
* Support investigation

Ask:

* Can the change be rolled back safely?
* Does rollback also require reverting data?
* Can a timeout create duplicate side effects?
* Will operators know when the flow fails?
* Can one tenant or user affect others?
* Could the change increase production cost significantly?
* Are dashboards or alerts needed?
* Will old data break the new implementation?

## 13. Observability

Review:

* Structured logs
* Correlation IDs
* Trace propagation
* Provider identifiers
* Stable error categories
* Retry visibility
* Duplicate-operation visibility
* Audit requirements
* Sensitive-data redaction
* Alertability
* Production diagnostics

Determine whether an engineer could answer:

* What failed?
* Where did it fail?
* Which operation was affected?
* Was the provider called?
* Was the operation retried?
* Was duplicate execution prevented?
* Which version was deployed?
* Can the issue be correlated across services?

Do not demand logs in every function.

Require only signals that materially improve investigation.

## 14. Dependency impact

When dependencies changed, review:

* Necessity
* Version
* Lockfile
* Transitive dependencies
* Security advisories
* Install scripts
* Runtime compatibility
* License
* Bundle impact
* Native code
* Telemetry
* Provider lock-in
* Upgrade path

Do not approve unexplained lockfile changes.

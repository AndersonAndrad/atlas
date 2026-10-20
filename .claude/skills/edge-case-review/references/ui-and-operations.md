# UI and operational edge cases

Use for frontend interactions, error contracts, backward compatibility,
configuration, and resource limits.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 21. Frontend interactions

Test:

* Double-click
* Rapid repeated click
* Submit using Enter
* Submit using button
* Back button
* Refresh during processing
* Modal closed during request
* Navigation during request
* Slow network
* Offline behavior
* API error
* Empty state
* Loading state
* Disabled state
* Keyboard-only flow
* Screen zoom
* Mobile viewport
* Paste into masked input
* Autocomplete
* Browser autofill
* Lost focus
* Returning to the page with stale state

Do not rely on hover for essential functionality.

## 22. Error handling

For every expected failure, verify:

* Correct error category
* Safe user-facing message
* Useful internal context
* Sensitive values are redacted
* Partial state is handled
* Retry behavior is intentional
* Duplicate retry is safe
* Logs are not duplicated excessively
* Error does not get swallowed
* Cleanup occurs when required

Test both known errors and unexpected exceptions.

## 23. Backward compatibility

Consider:

* Existing clients omitting the new field
* Existing clients sending old values
* Old records missing new properties
* New backend with old frontend
* Old backend with new frontend
* Old queue messages
* Old webhook payloads
* Old cached values
* Existing environment configuration
* Rolling deployment with mixed application versions
* Database migration running while old code is active

Do not assume all components deploy simultaneously.

## 24. Configuration

Review:

* Missing environment variable
* Empty environment variable
* Invalid format
* Invalid URL
* Wrong environment value
* Secret accidentally exposed
* Default value used in production
* Boolean parsed incorrectly
* Numeric value outside range
* Different behavior between local, test, staging, and production
* Configuration changed without restart
* Multiple configuration sources disagreeing

Fail fast for configuration required for safe application startup.

## 25. Operational limits

Consider:

* Maximum request size
* Maximum execution time
* Rate limit
* Memory usage
* CPU-intensive inputs
* Database connection limits
* Queue backlog
* Thread or worker exhaustion
* External provider quotas
* Large response payloads
* Unbounded logs

A valid request can still be operationally unsafe.

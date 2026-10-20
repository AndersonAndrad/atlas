# Input and identity edge cases

Use for missing/text/numeric/date/collection values, pagination, identifiers,
authentication, authorization, and normalization boundaries.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 3. Empty and missing values

Test the difference between:

* Field omitted
* `undefined`
* `null`
* Empty string
* String containing one space
* String containing multiple spaces
* Tab
* Newline
* Empty array
* Empty object
* Zero
* `false`
* Missing nested property

Do not assume these values have the same meaning.

Verify whether the system:

* Rejects the value
* Applies a default
* Preserves the value
* Removes the field
* Treats it as an update
* Treats it as no change
* Produces a clear error

Be especially careful with partial updates.

A missing field and a field explicitly set to `null` may represent different
intentions.

## 4. Text values

For text inputs, consider:

* Empty string
* Whitespace-only string
* Leading whitespace
* Trailing whitespace
* Multiple internal spaces
* Tabs
* Line breaks
* Very long strings
* Single-character strings
* Accented characters
* Unicode
* Emojis
* Right-to-left text
* Combining characters
* Different Unicode representations
* HTML
* Script-like content
* SQL-like content
* NoSQL operator-like content
* File paths
* URLs
* Encoded content
* Null characters
* Control characters

Examples:

```text
""
" "
"   "
"\t"
"\n"
" João "
"João  da  Silva"
"José"
"中文"
"😀"
"👨‍👩‍👧‍👦"
"<script>alert(1)</script>"
"../../arquivo"
"$ne"
```

Do not recommend rejecting Unicode or emojis unless the domain requires it.

Verify length by the same unit used by the business rule:

* Bytes
* Characters
* Unicode code points
* Grapheme clusters

These are not always equivalent.

## 5. Input normalization

Review every transformation applied to input:

* Trim
* Lowercase
* Uppercase
* Accent removal
* Mask removal
* Space collapsing
* Number conversion
* Date conversion
* Boolean conversion
* Unicode normalization
* Empty-to-null conversion

Ask:

* Can valid data be changed?
* Can two different values become identical?
* Does normalization happen before uniqueness validation?
* Is normalization consistent between create, update, search, and authentication?
* Is the original value needed later?
* Does frontend behavior match backend behavior?
* Can normalization break signatures or provider identifiers?

Never normalize blindly:

* Passwords
* Tokens
* API keys
* Hashes
* Cryptographic signatures
* Secrets
* Encoded payloads
* File contents
* Values compared byte-for-byte

## 6. Numeric values

Consider:

* Zero
* Negative values
* Minimum accepted value
* Maximum accepted value
* Just below the minimum
* Just above the maximum
* Decimal values
* Excess decimal precision
* Very large integers
* Floating-point precision
* Scientific notation
* Numeric string
* Empty numeric field
* `NaN`
* Infinity
* Negative zero
* Leading zeros

Examples:

```text
0
-1
1
0.01
0.1 + 0.2
999999999999999999
"00123"
"1e6"
```

For money:

* Avoid binary floating-point for authoritative calculations.
* Define rounding rules.
* Define accepted precision.
* Define currency.
* Define behavior for negative values.
* Define behavior for partial amounts.
* Verify totals after repeated calculations.

Do not assume rounding behavior.

## 7. Dates and time

Consider:

* Invalid date
* Leap year
* February 29
* End of month
* End of year
* Midnight
* Timezone conversion
* Daylight saving transitions
* UTC versus local time
* Date without timezone
* Date-only values
* Future date
* Past date
* Same start and end date
* End before start
* Maximum allowed range
* Locale-specific parsing
* Server and client in different timezones

Examples:

```text
2024-02-29
2025-02-29
2026-12-31T23:59:59Z
2026-01-01
```

Do not parse ambiguous dates such as:

```text
01/02/2026
```

without a defined locale or format.

Verify whether date boundaries are inclusive or exclusive.

## 8. Collections

Consider:

* Empty collection
* One item
* Maximum allowed items
* One item above the limit
* Duplicate items
* Same items in different order
* Null items
* Invalid item among valid items
* Large collection
* Repeated identifiers
* Missing identifiers
* Partial failure
* Collection modified during processing

Ask:

* Is ordering meaningful?
* Are duplicates allowed?
* Is processing atomic?
* Can part of the collection succeed?
* Is rollback required?
* Are results returned in the same order?
* Is collection size bounded?

Avoid unbounded processing.

## 9. Pagination, search, filtering, and sorting

Review:

* First page
* Last page
* Page beyond available results
* Page zero
* Negative page
* Excessive page size
* Empty search
* Whitespace-only search
* Special characters
* Accents
* Case sensitivity
* Multiple filters
* Conflicting filters
* Invalid sort field
* Invalid sort direction
* Stable ordering
* Duplicate sort values
* Data changing between pages

Verify that pagination has deterministic ordering.

Without stable ordering, records may be duplicated or skipped between pages.

## 10. Identifiers

Consider:

* Missing identifier
* Invalid format
* Valid format but nonexistent resource
* Identifier belonging to another user
* Reused identifier
* Case differences
* Leading zeros
* Very long identifier
* Provider identifier with unexpected characters
* Empty identifier
* Identifier modified by normalization

Verify resource ownership separately from identifier validity.

Do not expose whether a sensitive resource exists when enumeration is a risk.

## 11. Authentication

Review:

* Missing credentials
* Empty credentials
* Invalid token
* Expired token
* Revoked token
* Wrong token type
* Token for another environment
* Token with missing claims
* Token with extra claims
* Clock skew
* User disabled after token issuance
* Password with surrounding spaces
* Multiple active sessions
* Reused reset token
* Reused verification code
* Brute-force attempts

Verify that failures do not expose sensitive details.

## 12. Authorization

Consider:

* Authenticated but unauthorized
* Correct role, wrong resource owner
* Lower role manipulating identifiers
* User changing their own role
* Admin acting across tenants
* Missing tenant context
* Modified tenant identifier
* Permission removed during an active session
* Bulk operation containing unauthorized resources
* Indirect access through related resources

Do not rely only on hidden frontend controls.

Authorization must be enforced at the backend.

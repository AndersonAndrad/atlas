# Contract and domain terminology

Use for persistence, migrations, environment settings, events, public/external
contracts, units, scope, legacy names, and canonical domain terminology.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 24. Database naming

Review names for:

- Tables
- Collections
- Columns
- Indexes
- Constraints
- Foreign keys
- Migrations

Use consistent singular or plural conventions.

Names should describe business meaning.

Prefer:

```text
webhook_audits
organization_id
created_at
uq_customers_email
idx_webhook_audits_created_at
fk_orders_customer_id
```

Avoid:

```text
data
type
value
info
ref
field1
index1
constraint_new
```

Do not rename persisted objects without migration and compatibility analysis.

## 25. Migration naming

Migration names should describe the schema change.

Prefer:

```text
add_status_to_webhook_audits
create_customer_email_unique_index
rename_backoffice_user_context
```

Avoid:

```text
update_database
fix_table
changes
migration_42
new_fields
```

The name should remain useful when investigating migration history years later.

## 26. Environment variables

Environment variable names should:

- Use uppercase snake case.
- Identify the system or provider.
- Identify the value purpose.
- Indicate units when relevant.
- Avoid ambiguous generic names.

Prefer:

```text
FITBANK_API_BASE_URL
FITBANK_REQUEST_TIMEOUT_MS
JWT_ACCESS_TOKEN_TTL_MINUTES
DATABASE_CONNECTION_POOL_SIZE
```

Avoid:

```text
URL
TIMEOUT
TOKEN_TIME
DB_SIZE
KEY
SECRET
```

For sensitive values, the name may include:

```text
SECRET
TOKEN
API_KEY
PRIVATE_KEY
```

but documentation and logs must still protect the value.

## 27. Logs and metrics

Log events and metric names should use stable, searchable terminology.

Prefer:

```text
webhook_audit_processing_failed
payment_provider_timeout
authentication_failed
```

Avoid:

```text
error
failure
something_wrong
process_problem
```

Metric names should describe:

- Domain
- Operation
- Measurement
- Unit when relevant

Examples:

```text
webhook_processing_duration_ms
provider_requests_total
authentication_failures_total
```

Do not use variable resource identifiers in metric names.

## 28. Public contract naming

Public API fields must use consistent domain terminology.

Do not expose multiple names for the same concept.

Example inconsistency:

```text
organizationId
ownerId
employerId
accountOwnerId
```

when all refer to the same entity.

Before adding a public field:

1. Identify the real domain concept.
2. Search existing contracts.
3. Confirm whether similar names represent distinct concepts.
4. Select the canonical term.
5. Preserve compatibility when changing existing fields.
6. Document aliases or deprecations when necessary.

Do not select a field name based only on the current database column or provider
payload.

## 29. External-provider naming

Do not leak external-provider terminology into generic domain code unless the
concept is provider-specific.

Prefer:

```text
externalTransactionId
providerRequestId
paymentProvider
```

inside generic domain boundaries.

Use provider-specific names inside adapters:

```text
fitbankProtocol
fitbankBusinessUnitId
```

Do not call a generic domain identifier `fitbankId` when another provider may be
used later.

## 30. Singular and plural

Use singular names for one item and plural names for collections.

Prefer:

```ts
const customer = customers[0];
const auditRecords = await listAuditRecords();
```

Avoid:

```ts
const customers = customers[0];
const auditRecord = await listAuditRecords();
```

Method names should match result cardinality:

```text
findCustomerById
listCustomers
countCustomers
```

Do not use `getCustomers` when the function returns one customer.

## 31. Units and formats

Include units in names when ambiguity can cause errors.

Examples:

```text
timeoutMs
durationSeconds
amountInCents
fileSizeBytes
tokenTtlMinutes
percentageRate
createdAtUtc
```

Avoid:

```text
timeout
duration
amount
size
ttl
rate
date
```

when more than one interpretation is possible.

Do not add units redundantly when the type makes them impossible to confuse and
the project convention is already clear.

## 32. Scope-sensitive naming

Name length may depend on scope.

A short name can be acceptable in a tiny conventional scope:

```ts
coordinates.map(([x, y]) => ({ x, y }));
```

A broader scope requires a more descriptive name.

Avoid single-letter domain variables even inside callbacks:

```ts
filters.map((f) => f.method);
```

Prefer:

```ts
filters.map((filter) => filter.method);
```

The fact that a scope is short does not remove domain meaning.

## 33. Avoid type-only names

Do not name values only by their structure.

Avoid:

```text
stringValue
numberValue
objectData
arrayItems
responseObject
requestData
```

Prefer the business meaning:

```text
email
attemptCount
authenticatedContext
auditRecords
customerResponse
createCustomerRequest
```

Types already explain structure.

Names should explain purpose.

## 34. Avoid redundant context

Do not repeat context already guaranteed by the enclosing scope.

Inside `CustomerService`, this may be sufficient:

```ts
create();
findById();
```

rather than:

```ts
createCustomer();
findCustomerById();
```

provided the call site remains clear:

```ts
customerService.create();
```

However, exported standalone functions may require more context:

```ts
createCustomer();
```

Balance local clarity with call-site clarity.

## 35. Avoid misleading legacy names

When behavior changes, review whether names remain accurate.

Examples:

- A method named `create` now also updates.
- A field named `userId` now stores an organization ID.
- A variable named `ownerId` actually represents an employer ID.
- A guard named `SuperAdminGuard` protects only backoffice administrators.
- A function named `validate` also mutates values.

Misleading names are defects because they cause future incorrect use.

Rename local identifiers when safe.

For public contracts or persisted data, use a compatibility plan.

## 36. Source-of-truth terminology

For concepts that appear across layers, define one canonical term.

Examples:

```text
employer
organization
account
backoffice client
authenticated principal
webhook audit
```

Before naming a value:

1. Trace the source.
2. Identify its actual entity.
3. Verify whether a one-to-one relation makes two identifiers appear
   interchangeable.
4. Use the identifier for the actual concept required by the flow.
5. Do not use a convenient related ID merely because it currently maps 1:1.
6. Preserve domain distinction even when current data relationships overlap.

Example:

If tracing requires `employer_id`, do not name or populate it with
`organizationId` merely because the current relationship is one-to-one.

A name must describe what the value is, not what it happens to correlate with.

# Boundary, file, and UI naming

Use for repositories, guards, events, errors, constants, enums, files, folders,
components, hooks, and tests.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 13. Repository naming

Repository names should match the aggregate or persisted entity they manage.

Examples:

```text
CustomerRepository
PaymentRepository
WebhookAuditRepository
```

Methods should communicate query semantics:

```text
findById
findByOrganizationId
findActiveByEmail
existsByDocument
save
deleteById
```

Avoid:

```text
find
get
query
searchData
execute
doSave
```

when the condition or result is not clear.

Do not use one repository method name for materially different query behavior.

## 14. Guard, policy, and authorization naming

Authorization component names must describe the actual policy.

Prefer:

```text
BackofficeSuperAdminGuard
OrganizationMemberGuard
CanApproveRefundPolicy
CustomerOwnershipPolicy
```

Avoid:

```text
AuthGuard2
AdminGuard
PermissionGuard
RoleCheck
```

when the protected actor, role, permission, tenant, or resource is ambiguous.

Names must reflect the source and scope of authorization.

For example:

```text
BackofficeSuperAdminGuard
```

is clearer than:

```text
SuperAdminGuard
```

when the system has more than one kind of administrator.

Do not create multiple names for the same authorization rule.

## 15. Event naming

Events should use stable domain language and indicate completed facts.

Prefer past tense for facts that already occurred:

```text
CustomerCreated
PaymentAuthorized
RefundRequested
WebhookReceived
AccountDisabled
```

Commands should express intent:

```text
CreateCustomer
AuthorizePayment
RequestRefund
DisableAccount
```

Do not confuse commands and events.

Avoid:

```text
CustomerCreate
PaymentProcess
HandleRefund
EventData
GenericEvent
```

For serialized event names, use a consistent project format:

```text
customer.created
payment.authorized
refund.requested
```

Do not change event names without compatibility review.

## 16. Error naming

Error classes and codes should describe the failed rule.

Prefer:

```text
CustomerNotFoundError
InsufficientPermissionError
DuplicateWebhookError
InvalidOrderTransitionError
PROVIDER_TIMEOUT
CUSTOMER_ALREADY_EXISTS
```

Avoid:

```text
BusinessError
CustomError
GenericException
OperationFailed
ERROR_001
INVALID_DATA
```

Error names should help:

- Developers investigate
- Consumers react correctly
- Logs aggregate failures
- Tests assert specific behavior

Do not expose internal class names as public API error codes unless this is an
intentional convention.

## 17. Constants

Constants should explain meaning and units.

Prefer:

```ts
const MAX_LOGIN_ATTEMPTS = 5;
const PROVIDER_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 20;
const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;
```

Avoid:

```ts
const MAX = 5;
const TIMEOUT = 15000;
const DEFAULT = 20;
const TTL = 30;
```

Do not include mutable values in names that may become inaccurate.

Bad:

```ts
const THREE_RETRIES = config.maxRetries;
```

Better:

```ts
const maxRetries = config.maxRetries;
```

Use uppercase constants according to project and language conventions.

## 18. Enums

Enum names should represent one concept.

Enum values should use consistent grammar and abstraction level.

Good:

```ts
enum PaymentStatus {
  Pending = "pending",
  Processing = "processing",
  Completed = "completed",
  Failed = "failed",
}
```

Avoid mixing:

```ts
enum PaymentStatus {
  New = "new",
  IsProcessing = "processing",
  PaymentCompleted = "completed",
  Error = "failed",
}
```

Review whether:

- Values are mutually understandable.
- Names represent state, not actions.
- Serialization values are stable.
- Public values match documentation.
- Similar enums are not duplicated.

## 19. Files

File names must communicate their responsibility and follow project casing.

Examples for kebab-case projects:

```text
webhook-audit.controller.ts
webhook-audit.service.ts
webhook-audit.repository.ts
backoffice-super-admin.guard.ts
create-customer.request.dto.ts
```

Examples for snake_case projects:

```text
webhook_audit_controller.py
payment_repository.py
```

Do not mix casing styles without a framework reason.

Avoid vague filenames:

```text
utils.ts
helpers.ts
common.ts
shared.ts
misc.ts
temp.ts
new.ts
index2.ts
service-new.ts
controller-old.ts
```

A utility file should communicate its domain and purpose.

Prefer:

```text
document-normalization.ts
currency-formatting.ts
provider-error-mapping.ts
```

Avoid placing unrelated helpers into one broad file.

## 20. Folder naming

Folders should represent:

- Domain
- Feature
- Layer
- Boundary
- Capability

Use one dominant organizational model.

Examples:

```text
customers/
payments/
webhook-audits/
authentication/
```

or:

```text
controllers/
services/
repositories/
```

Avoid mixing feature-first and layer-first organization unpredictably within the
same area.

Avoid vague folders:

```text
common/
shared/
utils/
misc/
others/
new/
old/
temp/
```

These folders are acceptable only when their ownership and inclusion criteria
are explicit.

## 21. Component naming

Frontend components should describe the UI responsibility.

Prefer:

```text
WebhookAuditTable
CustomerCreationForm
PaymentStatusBadge
DeleteCustomerDialog
```

Avoid:

```text
AuditComponent
FormComponent
CustomTable
CommonModal
MainCard
Wrapper
Container
```

A component name should help a developer find where a user-facing behavior
lives.

## 22. Hooks and composables

Hooks should use the framework convention and describe the capability.

Examples:

```text
useWebhookAudits
useCustomerForm
usePaymentStatus
useDebouncedSearch
```

Avoid:

```text
useData
useFetch
useLogic
useHelper
useCommon
```

when the hook owns a specific domain behavior.

Names should indicate whether the hook:

- Fetches remote data
- Manages local form state
- Exposes an action
- Observes a status
- Coordinates a workflow

## 23. Test files and test names

Test file names should clearly map to the tested unit or flow.

Examples:

```text
backoffice-super-admin.guard.spec.ts
webhook-audit.controller.spec.ts
create-customer.e2e-spec.ts
```

Test names should describe:

- Initial condition
- Action
- Expected result

Prefer:

```ts
it(
  "rejects a request when the authenticated user is not a super administrator",
);
```

Avoid:

```ts
it("works");
it("test guard");
it("should return false");
```

A good test name should explain the business behavior even when the assertion
fails.

# Identifier and action naming

Use for abbreviations, variables, booleans, functions, classes, interfaces, DTOs,
controllers, services, and query/command distinctions.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 3. Avoid unclear abbreviations

Do not abbreviate a domain concept merely to make the name shorter.

Prefer:

```ts
const loadAuditList = async (filter: FitbankWebhookAuditFilter) => {};
```

Avoid:

```ts
const loadList = async (f: FitbankWebhookAuditFilter) => {};
```

Prefer:

```ts
const authenticatedBackofficeClient = request.backOfficeClient;
```

Avoid:

```ts
const boc = request.backOfficeClient;
```

A name is too abbreviated when the reader must:

- Inspect the type
- Read the body
- Search the caller
- Translate a team-specific acronym
- Guess which concept the letter represents
- Remember surrounding context

Generally avoid:

```text
a
b
c
d
e
f
x
y
z
arr
obj
tmp
val
res
req
ctx
cfg
usr
usrId
svc
repo
mgr
util
info
data
item
thing
stuff
```

Exceptions may exist when the abbreviation is:

- Universally established
- Standard in the language or framework
- Clearer than the expanded form
- Used in a very small conventional scope

Commonly acceptable examples:

```text
id
url
uri
api
http
https
html
css
sql
jwt
dto
ui
ux
cpu
ip
uuid
```

Context-dependent abbreviations such as `req`, `res`, `ctx`, `repo`, `config`,
and `auth` should follow explicit project conventions.

Do not expand established terms mechanically.

`userId` is better than `userIdentifier`.

`url` is better than `uniformResourceLocator`.

## 4. Variables

Variable names must describe the value's meaning, not merely its type.

Prefer:

```ts
const auditRecords = await service.getAuditList(filter);
const authenticatedUser = request.authenticatedUser;
const failedTransactions = transactions.filter(
  (transaction) => !transaction.success,
);
```

Avoid:

```ts
const data = await service.getAuditList(filter);
const obj = request.authenticatedUser;
const arr = transactions.filter((item) => !item.success);
```

Review whether:

- The name describes the actual value.
- Singular and plural forms are correct.
- Collection names are plural.
- Boolean names communicate true and false meaning.
- Units are represented when relevant.
- Raw and transformed values are distinguishable.
- Previous and next state are distinguishable.
- Similar values are not given nearly identical names.

Examples:

```ts
const amountInCents = 1050;
const amountInReais = 10.5;

const rawDocument = input.document;
const normalizedDocument = normalizeDocument(rawDocument);

const previousStatus = order.status;
const nextStatus = OrderStatus.Cancelled;
```

Avoid:

```ts
const amount = 1050;
const document2 = normalizeDocument(document);
const statusNew = OrderStatus.Cancelled;
```

## 5. Boolean names

Boolean names should read naturally as true or false.

Prefer prefixes such as:

- `is`
- `has`
- `can`
- `should`
- `was`
- `did`
- `will`
- `requires`
- `supports`

Examples:

```ts
const isActive = user.status === UserStatus.Active;
const hasPermission = permissions.includes(requiredPermission);
const canRetry = attempt < maxAttempts;
const shouldShowError = touched && Boolean(error);
const requiresAuthentication = route.isProtected;
```

Avoid:

```ts
const active = true;
const permission = false;
const retry = true;
const status = false;
```

Avoid negative booleans when they create double negatives.

Prefer:

```ts
if (isEnabled) {
}
```

Instead of:

```ts
if (!isDisabled) {
}
```

When a negative concept is part of the domain, use it carefully:

```ts
const isUnavailable = provider.status === ProviderStatus.Unavailable;
```

## 6. Functions and methods

Function names should describe behavior and side effects.

Use verbs.

Examples:

```ts
loadWebhookAudits;
createCustomer;
updateAccountStatus;
validatePermission;
calculateOrderTotal;
normalizeDocument;
publishPaymentEvent;
mapProviderError;
```

Avoid vague names:

```ts
handle;
process;
execute;
run;
doWork;
manage;
perform;
action;
method;
helper;
utils;
```

Generic verbs may be acceptable when the surrounding abstraction makes the
meaning explicit.

For example:

```ts
paymentProcessor.process(payment);
```

may be clear because `PaymentProcessor` defines the context.

Avoid names that hide side effects.

Bad:

```ts
getUser();
```

when it also updates access time, writes an audit record, and refreshes cache.

Better:

```ts
getUserAndRecordAccess();
```

or separate responsibilities when appropriate.

Function names should distinguish:

- Fetching versus loading
- Reading versus creating
- Validating versus transforming
- Calculating versus persisting
- Publishing versus handling
- Starting versus completing
- Attempting versus guaranteeing

Examples:

```text
findUser
getUserOrThrow
createUser
saveUser
validateUser
normalizeUserInput
publishUserCreatedEvent
handleUserCreatedEvent
```

Do not use `get` for every operation.

## 7. Command-query distinction

Names should clarify whether a function reads data or changes state.

Queries usually use names such as:

- `find`
- `get`
- `list`
- `search`
- `count`
- `exists`
- `can`
- `has`

Commands usually use names such as:

- `create`
- `update`
- `delete`
- `remove`
- `cancel`
- `approve`
- `publish`
- `send`
- `reserve`
- `revoke`

Avoid a read-like name for a write operation.

Bad:

```ts
getOrCreateUser();
```

when the creation side effect is not obvious to the caller.

Use an explicit name or separate operations.

## 8. Classes

Class names should represent a clear responsibility or domain concept.

Use nouns.

Examples:

```text
PaymentService
CustomerRepository
BackofficeSuperAdminGuard
WebhookAuditController
CreateCustomerCommand
GetAuditListQuery
FitbankWebhookAdapter
JwtAuthenticationStrategy
```

Avoid:

```text
PaymentManager
CustomerHelper
CommonUtils
GeneralService
DataProcessor
SystemHandler
BaseManager
```

Class names should not rely on vague suffixes to create meaning.

A class ending in `Service`, `Manager`, `Helper`, or `Processor` still needs a
specific responsibility.

Review whether the class name matches what it actually does.

A class named `CustomerService` that handles authentication, payment, email,
and reports may be hiding excessive responsibility.

## 9. Interfaces and types

Use names that communicate the represented contract.

Examples:

```ts
interface AuthenticatedBackofficeContext {}
interface WebhookAuditFilter {}
interface CreateCustomerInput {}
interface CustomerResponse {}
type PaymentStatus = "pending" | "completed" | "failed";
```

Avoid meaningless prefixes or suffixes unless project conventions require them.

Potentially avoid:

```text
IUserService
TUser
UserInterface
UserType
UserData
```

when the language and project already make the construct clear.

Do not create two names for the same concept, such as:

```text
BackofficeUser
BackOfficeClient
AuthenticatedClient
CurrentUser
```

without an explicit distinction.

When names represent different concepts, document and preserve the difference.

## 10. DTO naming

DTO names should make direction and use case explicit.

Prefer:

```text
CreateCustomerRequestDto
CreateCustomerResponseDto
UpdateCustomerRequestDto
ListWebhookAuditsQueryDto
WebhookAuditResponseDto
```

or the project's established equivalent.

Avoid:

```text
CustomerDto
CustomerDataDto
CustomerPayload
CustomerModel
```

when the same object could mean request, response, persistence, or domain data.

Do not reuse the same DTO blindly for:

- Create
- Update
- Response
- Persistence
- External-provider requests
- Internal domain commands

The name should reveal the DTO's boundary.

## 11. Controller and route naming

Controller names should match the route resource or business capability.

Examples:

```text
WebhookAuditController
CustomerController
PaymentRefundController
```

Route names should:

- Use consistent pluralization.
- Use domain terminology.
- Avoid technical implementation details.
- Avoid verbs when a resource-oriented route is appropriate.
- Distinguish actions only when they represent domain commands.

Prefer:

```text
GET /webhook-audits
POST /customers
PATCH /orders/{orderId}
POST /orders/{orderId}/cancel
```

Avoid:

```text
GET /getWebhookAuditList
POST /createCustomer
POST /updateOrderStatus
```

unless the project intentionally uses RPC-style routes.

Do not rename public routes without compatibility analysis.

## 12. Service naming

Service names should identify the capability they own.

Prefer:

```text
WebhookAuditService
PaymentAuthorizationService
CustomerOnboardingService
```

Avoid:

```text
CommonService
SharedService
GenericService
MainService
UtilsService
```

A service name that could apply to most of the application usually lacks a clear
boundary.

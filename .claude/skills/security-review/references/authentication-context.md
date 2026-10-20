# Authentication context and trusted identity source

For any authentication or authorization change, read the complete authentication
reference before implementing or approving it. Trace credential validation,
principal creation, the canonical context, all guards/consumers, and isolated
policy tests. Raw decoded tokens and client-controlled roles are never trusted.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## Authentication context and trusted identity source

Authentication and authorization must use a single, explicit, and trusted
request identity source.

Before adding or changing any authorization rule:

1. Locate where the authentication credential enters the application.
2. Locate where the JWT, session, API key, or other credential is validated.
3. Inspect the complete validated payload.
4. Identify where the authenticated principal is created.
5. Identify where that principal is attached to the request or execution
   context.
6. Identify the canonical request property or context accessor.
7. Search for existing guards, decorators, interceptors, middleware, and
   helpers that already expose the authenticated principal.
8. Search for competing properties or context shapes.
9. Verify which source is trusted and which sources are only client input.
10. Reuse the canonical source instead of reconstructing identity in
    controllers or services.

Do not add authorization logic before tracing the complete authentication
pipeline.

### Trusted identity source

Authorization decisions must use information obtained from a validated
authentication credential.

Examples include:

* Validated JWT claims
* Validated session data
* Validated service credentials
* Authenticated API client context
* Trusted identity loaded from persistence after token validation

Do not authorize using values supplied directly by:

* Request body
* Query parameters
* Route parameters
* Unvalidated headers
* Client-controlled cookies
* Frontend state

A request may contain identifiers for selecting a resource, but those
identifiers must not replace the authenticated principal.

### Canonical request context

The project must define one canonical authenticated-context shape.

Example:

```ts
type AuthenticatedBackofficeContext = {
    userId: string;
    role: BackofficeRole;
    clientId?: string;
    tenantId?: string;
};
```

The context should be attached consistently, for example:

```ts
request.authenticatedBackoffice
```

or exposed through a dedicated decorator:

```ts
@CurrentBackofficeUser()
```

Do not create multiple competing properties such as:

```ts
request.backofficeUser
request.backOfficeClient
request.user
request.authUser
```

unless they represent intentionally different authenticated actors and that
difference is documented and enforced.

When competing properties already exist:

1. Trace which component populates each property.
2. Compare their types and semantics.
3. Identify which one comes from validated authentication.
4. Identify all consumers.
5. Select the canonical property.
6. Migrate consumers incrementally.
7. Remove or deprecate ambiguous alternatives.
8. Add tests preventing the old convention from returning unnoticed.

Do not guess which request property is correct based only on its name.

### Validate before injection

Never trust authentication claims merely because they exist in a decoded token.

Before injecting authentication data into the request context, verify all
applicable properties:

* Signature
* Allowed algorithm
* Expiration
* Not-before time
* Issuer
* Audience
* Token type
* Required claims
* User or client status
* Session or token revocation
* Tenant relationship
* Role validity
* Permission validity
* Credential environment
* Key rotation state

Decoding is not validation.

A decoded payload must not be treated as an authenticated principal until the
credential has been fully verified.

### Validate the injected context

The component that creates the authenticated context must validate its shape.

Do not inject an untyped or partially trusted payload directly:

```ts
request.backofficeUser = decodedToken;
```

Prefer creating an explicit internal context:

```ts
request.authenticatedBackoffice = {
    userId: validatedToken.sub,
    role: validatedRole,
    clientId: validatedClientId,
};
```

Only include claims required by downstream authorization and business logic.

Do not propagate the complete raw token payload through the application unless
there is a demonstrated need.

### Centralize authorization rules

Repeated authorization checks must be extracted to the appropriate reusable
boundary.

Avoid:

```ts
if (request.backOfficeClient.role !== BackofficeRole.SuperAdmin) {
    throw new ForbiddenException();
}
```

repeated across controllers.

Prefer:

```ts
@UseGuards(BackofficeSuperAdminGuard)
```

The guard must read the canonical authenticated context.

Example:

```ts
@Injectable()
export class BackofficeSuperAdminGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<
            AuthenticatedBackofficeRequest
        >();

        const authenticatedBackoffice =
            request.authenticatedBackoffice;

        if (!authenticatedBackoffice) {
            throw new UnauthorizedException();
        }

        if (
            authenticatedBackoffice.role !==
            BackofficeRole.SuperAdmin
        ) {
            throw new ForbiddenException();
        }

        return true;
    }
}
```

The guard must distinguish:

* Missing or invalid authentication context: unauthenticated
* Valid authentication context without permission: unauthorized for the action

Do not collapse every failure into the same condition without reviewing project
error conventions.

### Search before creating

Before creating a new guard, decorator, helper, or request property:

1. Search for guards checking the same role or permission.
2. Search for request property names used by authentication code.
3. Search for decorators exposing the current principal.
4. Search for middleware or strategies populating the request.
5. Search for duplicated inline authorization checks.
6. Search for tests covering equivalent authorization behavior.
7. Inspect whether an existing implementation is correct before reusing it.

Do not reuse an existing guard blindly.

An existing guard may itself read the wrong request property or trust an
unvalidated source.

### Role and permission source

Roles and permissions must come from an explicitly defined source.

Determine whether roles and permissions are:

* Embedded in the validated JWT
* Loaded from the database after JWT validation
* Loaded from cache
* Derived from the authenticated client
* Combined from multiple sources

Define which source is authoritative.

When using claims from the JWT, review:

* Whether permission changes must take effect immediately
* Token expiration duration
* Revocation behavior
* Disabled-user behavior
* Role changes during an active token
* Tenant changes during an active token

When immediate permission revocation is required, JWT claims alone may be
insufficient without:

* Short token expiration
* Token version validation
* Revocation list
* Session lookup
* User-status lookup
* Permission reload

Do not assume JWT claims are permanently current.

### Authorization must not be duplicated

Repeated inline authorization is a finding when it represents the same policy.

Report duplication when:

* The same role comparison appears in multiple controllers.
* The same ownership check appears in multiple handlers.
* The same permission array is interpreted in multiple places.
* The same tenant validation is repeated.
* Different request properties are used for the same authenticated actor.
* Error behavior differs between copies.
* One copy validates missing context and another assumes it exists.

Repeated authorization rules can diverge silently.

A new protected endpoint should reuse the same policy component rather than
copy an existing conditional.

### Policy ownership

Authorization policy should live in the narrowest reusable component that owns
the rule.

Use:

* Guard for endpoint access
* Policy or authorization service for business-level decisions
* Resource ownership service for reusable ownership checks
* Decorator for declarative metadata
* Authentication strategy or middleware for identity creation

Do not place all authorization in controllers.

Do not place all domain-specific authorization in generic guards.

Examples:

```text
Only super administrators may access this route
→ Guard

A manager may approve an expense only for their department
→ Domain authorization policy or service

A user may update only resources they own
→ Reusable ownership policy with resource lookup
```

### Required tests

Add isolated tests for the authentication and authorization components.

For an authentication-context creator, test:

* Valid credential creates the expected canonical context.
* Invalid signature does not create context.
* Expired token does not create context.
* Missing required claims do not create context.
* Invalid role does not create context.
* Revoked or disabled principal does not create context when applicable.
* Raw client values cannot override authenticated claims.

For a role guard, test:

* Missing context is rejected.
* Correct role is allowed.
* Incorrect role is rejected.
* Similar but invalid role values are rejected.
* The guard reads only the canonical request property.
* Legacy or competing request properties are not silently trusted.
* The guard does not depend on controller-specific behavior.

For protected controllers, test:

* The guard is attached.
* The controller does not repeat the role check.
* Business behavior is tested separately from authorization policy.

Do not rely only on controller tests to prove guard behavior.

### Review questions

During review, ask:

* Where is the authenticated principal created?
* Was the credential validated before the context was injected?
* What is the canonical request property?
* Are there competing request properties?
* Does this authorization rule already exist?
* Is the rule duplicated inline?
* Does the guard use the same context populated by authentication?
* Can client input override the authenticated role or identity?
* Are roles current enough for the business requirement?
* Is missing authentication distinguished from missing permission?
* Is the policy tested independently?
* Will a new endpoint naturally reuse this policy?

### Required finding

Report at least a Medium finding when the same authorization policy is copied
across multiple endpoints.

Raise severity when duplication may cause:

* Authorization bypass
* Tenant isolation failure
* Administrative privilege inconsistency
* Different behavior between endpoints
* Client-controlled role usage
* Trust in an unvalidated request property

A duplicated super-administrator check is not only a maintainability problem.

It is a security-policy consistency risk.

---
name: security-log
description: Ensures client-facing API errors expose minimal information while internal logs keep useful, non-sensitive diagnostics. Use when implementing or reviewing changes to error responses, exceptions, validation, authentication, registration, account recovery, authorization, or logging. Applies only to the requested change unless the developer explicitly requests a project-wide review.
---

# Secure API Error Responses

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

## Purpose

This skill ensures that APIs do not expose internal implementation details, validation rules, authentication clues, infrastructure information, or other sensitive diagnostic information through client-facing responses.

The core principle is:

> **External responses expose the minimum useful information. Internal logs preserve the maximum useful diagnostic information. Sensitive data is never logged.**

The API consumer should receive a safe and sanitized response.

Developers and operators should still have enough information in internal logs to understand exactly what failed.

## Scope

Apply this skill only to the flows the requested implementation creates or
modifies, including existing error handling, logging, and responses those
changes directly affect. During Staff review, assess only the current diff and
its affected paths.

Do not search, audit, or change the whole project, and do not run the
Implementation Workflow below across unrelated endpoints, unless the developer
explicitly requests a project-wide review. Before such a review, present its
scope and risks, such as contract breaks and a large diff, under
`implementation-plan` and obtain explicit acceptance. Report pre-existing leaks
noticed in affected code without correcting unrelated code.

---

## Primary Rule

Never expose internal or security-relevant diagnostic details directly to API consumers.

When an error occurs:

1. Preserve the original error internally.
2. Log the actual reason with appropriate context.
3. Return a sanitized response to the client.
4. Include a correlation/request ID when the project supports it.
5. Never include sensitive values in either the response or logs.

Example:

### Unsafe

```json
{
  "statusCode": 400,
  "message": "email is required"
}
```

### Preferred external response

```json
{
  "statusCode": 400,
  "message": "Unable to process the request.",
  "requestId": "abc123"
}
```

### Internal log

```text
WARN CreateUser validation failed
reason="email is required"
field="email"
requestId="abc123"
```

The detailed reason exists internally but is not disclosed through the API.

---

# Threat Model

Assume that any public or externally reachable endpoint may be called by an unauthorized or malicious client.

Do not assume that the caller:

- is using the official frontend;
- has access to the documentation;
- understands the expected payload;
- is authenticated unless authentication has already been verified;
- is authorized merely because authentication succeeded.

Error responses must not become an interactive guide for discovering how the system works.

---

# Information That Must Not Be Exposed

Client-facing responses must not reveal unnecessary details about:

- required sensitive fields;
- authentication rules;
- authorization rules;
- whether a specific account exists;
- whether an email, username, phone number, document number, or account is registered;
- password validation internals;
- token validation internals;
- database structure;
- table names;
- column names;
- SQL queries;
- ORM internals;
- stack traces;
- source code locations;
- filenames;
- filesystem paths;
- internal class names;
- internal method names;
- internal service names;
- microservice topology;
- infrastructure;
- container information;
- environment variables;
- third-party credentials;
- secrets;
- API keys;
- tokens;
- cookies;
- Authorization headers;
- internal URLs;
- private IP addresses;
- ports;
- dependency errors;
- framework-generated diagnostic information.

---

# Authentication and Enumeration

Authentication endpoints require special attention.

Never reveal whether authentication failed because:

- the user does not exist;
- the email does not exist;
- the password is incorrect;
- the account exists but uses another authentication method;
- the account is disabled;
- an internal lookup failed.

Instead of:

```text
User with email john@example.com does not exist.
```

or:

```text
Incorrect password.
```

prefer:

```text
Invalid credentials.
```

Internally, logs may distinguish the reason:

```text
Authentication failed
reason="user_not_found"
requestId="abc123"
```

or:

```text
Authentication failed
reason="password_mismatch"
requestId="abc123"
```

Do not include passwords or credential values in logs.

---

# Registration and Account Recovery

Avoid responses that unnecessarily confirm whether an identity already exists.

Potentially unsafe:

```text
This email is already registered.
```

Safer when enumeration is a concern:

```text
Unable to complete registration.
```

For password recovery flows, prefer responses such as:

```text
If the account is eligible, recovery instructions will be sent.
```

Do not disclose whether the supplied email or account exists unless the product explicitly requires that information and the disclosure has been reviewed as safe.

---

# Validation Errors

Do not blindly hide every validation error.

The goal is security, not making the API impossible to use.

Validation errors may remain descriptive when they:

- are part of the documented public API contract;
- do not reveal sensitive business rules;
- do not enable account/resource enumeration;
- do not reveal authentication or authorization behavior;
- do not reveal internal implementation details.

For example:

```text
page must be greater than 0
```

may be acceptable for a documented pagination parameter.

However:

```text
email is required before the system checks whether the account exists
```

may expose useful information about an authentication or registration flow and should be sanitized when appropriate.

When uncertain, prefer the less revealing response.

---

# Authorization

Do not expose unnecessary details explaining why access was denied.

Avoid:

```text
You cannot access this invoice because it belongs to user 98231.
```

Prefer:

```text
You are not authorized to perform this operation.
```

Where resource enumeration is a concern, consider returning the same external behavior for unauthorized and nonexistent resources.

Example:

```text
Resource not found.
```

Internally distinguish:

```text
reason="resource_not_found"
```

from:

```text
reason="resource_owned_by_different_user"
```

---

# Internal Errors

Unexpected exceptions must never reach clients unchanged.

Never expose errors such as:

```text
ECONNREFUSED 10.0.4.21:5432
```

```text
relation "users_credentials" does not exist
```

```text
TypeError: Cannot read properties of undefined
```

```text
PrismaClientKnownRequestError...
```

```text
MongoServerError...
```

Instead return something similar to:

```json
{
  "statusCode": 500,
  "message": "An unexpected error occurred.",
  "requestId": "abc123"
}
```

The complete diagnostic information should remain available internally.

---

# Logging Requirements

Sanitizing the external response must never destroy the original diagnostic information.

Internal logs should preserve useful context such as:

- actual exception;
- error type;
- operation;
- service/module;
- route;
- HTTP method;
- request ID;
- correlation ID;
- authenticated actor ID when safe;
- error code;
- stack trace for unexpected errors;
- relevant non-sensitive metadata.

Example:

```text
ERROR CreateUser failed
error="Database connection timeout"
operation="create_user"
route="POST /users"
requestId="abc123"
userId="internal-user-id"
```

Prefer structured logging when supported by the project.

---

# Sensitive Logging Rules

Detailed logging does NOT mean unrestricted logging.

Never log raw:

- passwords;
- password confirmations;
- access tokens;
- refresh tokens;
- API keys;
- private keys;
- secrets;
- Authorization headers;
- session cookies;
- authentication cookies;
- CVV;
- complete payment card data;
- recovery tokens;
- MFA secrets;
- OTP codes.

Also inspect request bodies before logging them.

Do not blindly execute:

```ts
logger.error(request.body);
```

Redact sensitive fields first.

Example:

```json
{
  "email": "user@example.com",
  "password": "[REDACTED]",
  "accessToken": "[REDACTED]"
}
```

When possible, avoid logging sensitive fields entirely rather than merely masking them.

---

# Architecture

Prefer implementing error sanitization centrally.

Do NOT start by replacing hundreds of individual exceptions across the codebase.

First inspect the project for existing:

- global exception handlers;
- exception filters;
- error middleware;
- interceptors;
- validation pipelines;
- controllers;
- HTTP adapters;
- framework-level error handlers;
- logging infrastructure;
- correlation/request ID infrastructure.

Implement the policy at the API boundary whenever possible.

The desired architecture is:

```text
Application / Domain
        │
        │ rich internal errors
        ▼
Central Error Handler
        │
        ├──────────────► Internal Logger
        │                detailed diagnostic
        │
        ▼
Error Sanitizer
        │
        ▼
HTTP Response
safe external message
```

Domain/application code should be allowed to retain meaningful internal errors.

The external transport layer is responsible for deciding what information may leave the system.

---

# Framework Guidance

## NestJS

Prefer inspecting and using:

- `ExceptionFilter`;
- global exception filters;
- `HttpException`;
- `ValidationPipe`;
- interceptors;
- logger infrastructure.

When appropriate, implement a global exception filter that:

1. captures the original exception;
2. determines the appropriate HTTP status;
3. logs the original diagnostic information;
4. sanitizes the external message;
5. preserves explicitly approved public errors;
6. attaches the request/correlation ID;
7. returns the sanitized response.

Do not expose the raw result of:

```ts
exception.message
```

without first determining that the message is safe for external consumption.

---

## Express

Prefer centralized error middleware:

```text
route/controller
      ↓
application
      ↓
error middleware
      ├── log original error
      └── sanitize HTTP response
```

Avoid sending raw errors:

```ts
res.status(500).json({
  error: error.message
});
```

unless the message has explicitly been classified as public-safe.

---

# Error Classification

When implementing or reviewing the system, classify errors conceptually into categories such as:

```text
PUBLIC_SAFE
VALIDATION_SAFE
AUTHENTICATION
AUTHORIZATION
RESOURCE_ENUMERATION
BUSINESS_SENSITIVE
INTERNAL
INFRASTRUCTURE
```

Example behavior:

```text
PUBLIC_SAFE
→ preserve approved message

VALIDATION_SAFE
→ preserve documented validation message

AUTHENTICATION
→ generic authentication response

AUTHORIZATION
→ generic authorization/not-found response

RESOURCE_ENUMERATION
→ hide existence information

BUSINESS_SENSITIVE
→ sanitized business response

INTERNAL
→ generic internal error

INFRASTRUCTURE
→ generic internal error
```

Do not expose the internal classification itself unless it is intentionally part of the public API contract.

---

# Public Error Codes

When the project needs machine-readable errors, prefer stable public error codes over detailed internal messages.

Example:

```json
{
  "statusCode": 400,
  "code": "INVALID_REQUEST",
  "message": "Unable to process the request.",
  "requestId": "abc123"
}
```

Internally:

```text
code="CREATE_USER_EMAIL_REQUIRED"
publicCode="INVALID_REQUEST"
requestId="abc123"
```

This allows clients to handle errors without exposing internal implementation details.

---

# Existing API Contracts

Before changing existing error responses, inspect:

- API documentation;
- OpenAPI/Swagger definitions;
- frontend dependencies;
- mobile applications;
- automated tests;
- SDKs;
- integration tests;
- external integrations.

Do not silently break a documented public contract.

If an existing response leaks sensitive information but changing it may break consumers, report the issue and implement the safest backward-compatible solution possible.

---

# Implementation Workflow

When this skill is invoked:

1. Inspect the project's framework and architecture.

2. Locate the current error-handling strategy.

3. Identify the externally reachable endpoints affected by the requested change.

4. Within that scope, search for responses that expose raw exceptions or excessive diagnostic information.

5. Search for patterns such as:

```text
error.message
exception.message
throw new ...
res.json(error)
res.send(error)
JSON.stringify(error)
stack
cause
```

6. Identify affected authentication, registration, password recovery, account lookup, authorization, payment, and other sensitive flows.

7. Determine whether centralized error handling already exists.

8. Prefer improving the centralized mechanism instead of modifying every endpoint individually; changing a shared handler affects every endpoint, so include that impact in the plan and its risks.

9. Preserve detailed internal diagnostics.

10. Add or preserve request/correlation IDs where appropriate.

11. Ensure sensitive values are never logged.

12. Update tests.

13. Verify that safe documented validation errors continue to work.

14. Verify that sensitive/internal errors are sanitized.

15. Report what was changed and any remaining risks.

---

# Security Review Checklist

Before considering the work complete, verify:

- [ ] Raw exceptions are not returned to external clients.
- [ ] Stack traces are never exposed externally.
- [ ] Database errors are sanitized.
- [ ] Infrastructure errors are sanitized.
- [ ] Authentication responses do not unnecessarily enable account enumeration.
- [ ] Authorization responses do not leak resource ownership.
- [ ] Sensitive validation rules are not unnecessarily exposed.
- [ ] Safe documented validation remains useful.
- [ ] Internal logs preserve the actual diagnostic reason.
- [ ] Passwords are never logged.
- [ ] Tokens are never logged.
- [ ] Authorization headers are never logged.
- [ ] Cookies are not logged without safe redaction.
- [ ] Secrets and API keys are never logged.
- [ ] Request/correlation IDs connect client errors with internal logs when supported.
- [ ] Existing API contracts were considered.
- [ ] Automated tests cover sanitized responses.
- [ ] Automated tests verify that sensitive information does not leak.

---

# Testing Requirements

Tests should verify both sides of the boundary.

For example, given an internal failure:

```text
CreateUserError: email is required
```

the test should verify that the HTTP response does NOT contain:

```text
email is required
```

while the logging layer receives the appropriate internal diagnostic information.

Security-oriented tests should explicitly check that responses do not contain:

- stack traces;
- SQL;
- database names;
- internal paths;
- framework exception names;
- internal service names;
- authentication clues;
- sensitive field values.

---

# Important Constraints

Do not:

- convert every error into HTTP 500;
- hide HTTP status codes unnecessarily;
- destroy useful internal diagnostics;
- make documented public APIs unusable;
- duplicate error sanitization across every controller;
- expose raw exception messages by default;
- log entire request objects without redaction;
- change unrelated business logic while implementing this skill;
- assume an error message is safe simply because it currently exists in production.

---

# Decision Rule

For every external error message, ask:

> Could this information help an unauthorized caller understand the internal system, discover valid accounts/resources, infer security rules, or determine what input is required to progress further than they otherwise could?

If yes, sanitize it.

If no, and the information is part of a legitimate public API contract, it may remain descriptive.

---

# Final Principle

Always maintain this boundary:

```text
EXTERNAL RESPONSE
Minimum information required by the legitimate client.

INTERNAL OBSERVABILITY
Maximum diagnostic information required by developers and operators.

SENSITIVE DATA
Never exposed and never unnecessarily logged.
```

Security improvements must reduce information disclosure without sacrificing internal observability.
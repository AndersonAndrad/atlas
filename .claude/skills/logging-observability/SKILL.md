---

name: logging-observability
description: Reviews and improves logs, metrics, tracing, correlation identifiers, auditability, error categorization, production diagnostics, sensitive data redaction, and operational visibility. Use when implementing or modifying APIs, business flows, integrations, background jobs, queues, authentication, payments, persistence, error handling, or any behavior that may need investigation in production.
---

# Logging and Observability

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

Ensure that the implementation can be understood, monitored, and investigated
in production.

The objective is not to add logs everywhere.

The objective is to create useful operational signals without exposing
sensitive information, creating excessive noise, or increasing infrastructure
cost unnecessarily.

Apply `../security-log/SKILL.md` for the boundary between sanitized client
responses and internal diagnostics in affected error flows.

## 1. Understand the affected operation

Before adding logs or metrics:

1. Identify the operation being performed.
2. Identify the entry point.
3. Identify the main business steps.
4. Identify external dependencies.
5. Identify persistence operations.
6. Identify expected failures.
7. Identify unexpected failures.
8. Identify duplicate execution risks.
9. Identify what an operator would need to know during an incident.
10. Inspect existing observability patterns in the project.

Do not introduce a new logging format if the project already has a standard.

## 2. Define operational questions

Observability should answer practical questions.

Examples:

* Did the request reach the application?
* Which operation was attempted?
* Which resource was affected?
* Which user or tenant initiated the operation?
* Which step failed?
* Was the database operation completed?
* Was an external provider called?
* What response category did the provider return?
* Was the operation retried?
* Was a duplicate prevented?
* How long did the operation take?
* How often is this failure happening?
* Is the issue limited to one tenant, provider, route, or environment?
* Can the same request be traced across services?
* Was the final business operation successful?

Do not log information that does not help answer a real operational question.

## Signal design and privacy

Use for structured logging, levels, correlation, safe identifiers, redaction,
request/response/error handling, metrics/cardinality, and tracing. Read [references/signals-and-privacy.md](references/signals-and-privacy.md)
only for the applicable categories.

## Integration and audit signals

Use for external providers, retries, queues, webhooks, persistence,
transactions, caching, authentication, authorization, and business audit logs. Read [references/integrations-and-audit.md](references/integrations-and-audit.md)
only for the applicable categories.

## Operational signals and cost

Use for frontend signals, sampling, cost, health checks, alerts, dashboards,
feature flags, deployment observability, retention, and failure scenarios. Read [references/operations.md](references/operations.md)
only for the applicable categories.

## 44. Observability review matrix

Use a focused matrix when helpful:

| Scenario          | Signal               | Level        | Required context                              | Sensitive risk   | Action              |
| ----------------- | -------------------- | ------------ | --------------------------------------------- | ---------------- | ------------------- |
| Provider timeout  | Log + metric + trace | Error        | Provider, operation, correlation ID, duration | Provider payload | Add sanitized event |
| Duplicate webhook | Log + counter        | Info         | Event ID, provider, result                    | Signature        | Redact signature    |
| Invalid input     | Validation metric    | Info or none | Route, field category                         | User input       | Do not log value    |

Do not create a large matrix for trivial flows.

## 45. Implementation process

When applying this skill:

1. Inspect existing logger, tracing, and metrics infrastructure.
2. Identify the affected operational questions.
3. Identify existing project event conventions.
4. Add only the necessary signals.
5. Use stable structured fields.
6. Redact sensitive data.
7. Avoid duplicate logging.
8. Add tests for important log behavior when practical.
9. Validate that log output is useful.
10. Review telemetry cost and cardinality.
11. Run applicable tests.
12. Review the final diff.

Do not add a new observability dependency without checking whether existing
infrastructure already supports the requirement.

## 46. Testing observability

When practical, test:

* Correct event emitted
* Correct log level
* Correlation ID propagated
* Sensitive fields redacted
* Provider code preserved safely
* Retry attempt recorded
* Duplicate operation recorded
* Audit record created
* Unexpected error includes stack internally
* User response does not expose internal error
* Metrics use bounded labels
* Tracing context propagated

Avoid tests tightly coupled to irrelevant log formatting.

Test stable events and fields.

## 47. Review output

Provide:

## Operational questions

List what production investigation should be able to answer.

## Existing observability

Describe the signals already available.

## Missing signals

List missing logs, metrics, traces, or audit records.

## Sensitive data risks

Identify telemetry that may expose protected information.

## Recommendations

Prioritize concrete changes.

## Validation plan

Describe how the new observability will be verified.

## 48. Final report

After applying changes, provide:

## Signals added or changed

Describe logs, metrics, traces, or audit events.

## Correlation

Describe identifiers propagated through the flow.

## Redaction

Describe sensitive fields protected.

## Operational value

Explain which production questions can now be answered.

## Validation executed

List only commands and checks actually executed.

## Remaining limitations

State missing dashboards, alerts, infrastructure, or manual validation.

## Final status

Use exactly one:

* Validated
* Partially validated
* Not validated

## 49. Anti-patterns

Do not:

* Log complete request and response objects by default.
* Log passwords, tokens, secrets, or authorization headers.
* Add logs to every function.
* Log the same error in every layer.
* Use error level for expected user validation.
* Use dynamic exception messages as metric labels.
* Put user IDs or request IDs in metric labels.
* Assume HTTP success means business success.
* Ignore provider business codes.
* Generate a new correlation ID in every layer.
* Add observability without considering cost.
* Add dashboards for trivial changes.
* Expose stack traces to users.
* Store complete objects in audit logs.
* Claim a flow is observable without identifying what questions can be answered.
* Add a new monitoring dependency without checking existing infrastructure.
* Treat logs as a replacement for tests.

Good observability must improve production understanding without creating
security, privacy, noise, or cost problems.

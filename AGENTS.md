## Mandatory Staff PR review

After implementation and before final validation, load and apply the
`staff-pr-review` skill at `.claude/skills/staff-review/SKILL.md` to the complete current diff.

The review must evaluate:

* Architecture
* Security
* Performance
* Maintainability
* Readability
* Naming
* Complexity
* Correctness
* Test coverage
* Possible bugs
* Regressions
* Backward compatibility
* Observability
* Dependency impact
* Production impact
* Deployment and rollback risk

The reviewer must inspect:

* The complete diff
* Surrounding code
* Callers and consumers
* Existing tests
* Similar project implementations
* Public contracts
* Persistence and integration behavior

By default, the Staff PR review must not modify files.

For every finding, report:

* Severity
* Evidence
* Technical explanation
* Practical impact
* Recommended correction
* Suggested validation

Do not proceed to final validation while unresolved Critical or High findings
remain.

After corrections:

1. Review the complete diff again.
2. Confirm that findings were actually resolved.
3. Check whether corrections introduced new risks.
4. Only then run `final-validation`.

Automated checks are not a substitute for engineering review.


## Authentication and authorization context

Before implementing or modifying authentication or authorization:

1. Trace where the credential is received.
2. Trace where it is validated.
3. Confirm that signature, expiration, issuer, audience, token type, and
   required claims are validated when applicable.
4. Identify where the authenticated principal is created.
5. Identify the canonical request property or context accessor.
6. Search for existing guards, policies, decorators, and authorization helpers.
7. Search for duplicated inline authorization checks.
8. Verify that guards read the same property populated by authentication.
9. Verify that roles, permissions, tenant identifiers, and ownership are not
   taken from client-controlled input.
10. Add isolated tests for reusable guards and policies.

Authorization must use validated authentication context.

Do not trust raw decoded JWT payloads.

Do not introduce competing properties for the same authenticated actor.

Do not repeat role or permission checks across controllers.

When the same policy protects multiple endpoints, implement or reuse a
dedicated guard or authorization policy.

A mismatch between the property populated by authentication and the property
read by authorization is a blocking defect.

Examples:

```text
Authentication writes request.backOfficeClient
Guard reads request.backofficeUser
```

or:

```text
One controller checks request.backOfficeClient.role
Another guard checks request.backofficeUser.role
```

Before creating a new guard, verify the existing authentication pipeline and
the actual canonical context source.

Do not copy an existing guard until confirming that it reads the correct,
validated context.


## Exact Node.js dependency versions

All direct Node.js application dependencies and development dependencies must
use exact versions.

Use:

```json
{
  "dependencies": {
    "package-name": "1.2.3"
  }
}
```

Do not use:

```json
{
  "dependencies": {
    "package-name": "^1.2.3"
  }
}
```

Also avoid:

* `~1.2.3`
* `>=1.2.3`
* `*`
* `latest`
* Unpinned Git branches
* Unpinned Git tags

When installing packages, use the package-manager option that saves exact
versions.

Examples:

```bash
npm install --save-exact package-name@1.2.3
pnpm add --save-exact package-name@1.2.3
yarn add --exact package-name@1.2.3
```

Prefer configuring the repository with:

```ini
save-exact=true
```

in `.npmrc` when compatible with the project.

The lockfile does not replace exact direct dependency declarations.

A future lockfile regeneration must not be allowed to select a dependency
version that was never reviewed.

Exceptions such as `peerDependencies` in published libraries require explicit
compatibility analysis and must use the narrowest justified version range.

Any newly added or updated direct dependency using `^`, `~`, a wildcard, or an
open-ended range is a validation finding and must be corrected before approval.


## Mandatory implementation policies

Before any implementation, apply `.claude/skills/implementation-plan/SKILL.md`: investigate
read-only, present a concrete plan with alternatives, benefits, drawbacks, and
identified risks, then wait for explicit approval of that revision. When the
project has a `CHANGE_LOG.md`, record only actual approval and acknowledged
risks in it, with approver attribution and evidence, before implementing; when
it does not, do not create one. Use the Git `user.name` as author and approver
name, optionally complemented by the authenticated AI-host user identity.
Preserve approved decisions as append-only history. Material changes require
renewed approval; silence and approval of another revision are not consent.
Approval never waives unresolved Critical or High findings. Never invent
retrospective informed consent.

Apply `.claude/skills/development-workflow/SKILL.md` for every implementation. Its linked
skills define English code and comments with business/external-contract
exceptions, AI-authored documentation, responsive interfaces, automated
tests with mocked end-to-end integrations, input validation and context-safe
sanitization, security review, release metadata, formatting, and lint
requirements.

Apply `.claude/skills/security-log/SKILL.md` during implementation and Staff review whenever a
change touches error responses, exceptions, validation, authentication,
authorization, account flows, or logging. Limit it to the requested change; a
project-wide review requires an explicit developer request and acceptance of
its presented risks.

Preserve existing working-tree edits and staging state. Define testable
acceptance criteria before implementation. Scale Staff review depth to affected
risks while assessing every required dimension and preserving the complete-diff
review and Critical/High gate. Reuse findings across skills.

The AI agent authors documentation for modified behavior using the project's
existing tooling, such as Swagger/OpenAPI. When no documentation tooling exists,
add nothing and notify the developer why documentation could not be produced.
Documentation, tests, and corrections cover only what the task created or
modified; pre-existing content is out of scope unless the user requests it.
The developer's responsibility is to review all changes and create commits.
Executable schemas and validators remain subject to correctness review, and
mandatory version updates still apply.

Apply `.claude/skills/release-changelog/SKILL.md` before Staff review. Maintain `CHANGE_LOG.md`
only when it already exists, and increase the application version in
`package.json` when present.

AI agents must never create commits, even when asked to commit. Prepare an
English message using the project convention or Conventional Commits and leave
commit execution to the user.

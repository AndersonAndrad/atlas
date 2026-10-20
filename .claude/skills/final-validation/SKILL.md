---
name: final-validation
description: Mandatory final review for any completed implementation, bug fix, refactor, configuration change, dependency change, or production code modification. Use immediately before reporting completion.
---

# Final Validation

Do not finish the task before performing this validation.

## Pre-validation gate

Before running validation commands, confirm:

* The complete diff was reviewed.
* The intended requirement was compared against the implementation.
* Architecture was reviewed when the change affects structure or boundaries.
* Security was reviewed when the change affects input, authentication,
  authorization, secrets, personal data, files, or external access.
* Edge cases were reviewed.
* Duplicate execution and concurrency were considered when relevant.
* Production impact was reviewed.
* Observability was reviewed for operationally relevant flows.
* Dependency changes were reviewed.
* Migrations and backward compatibility were reviewed.
* Test coverage was evaluated for missing scenarios.
* Critical and High findings were corrected.
* The final diff was reviewed again after corrections.

If an applicable review was not executed, final status cannot be `Validated`.

Use `Partially validated` and clearly state which review remains missing.


## Final validation is not a code review

Final validation does not replace:

* Requirements review
* Architecture review
* Security review
* Edge-case review
* Staff PR review
* Critical code review
* Dependency review
* Observability review
* Test coverage analysis

Formatter, lint, type checking, tests, and build only prove that the executed
checks completed successfully.

They do not prove that:

* The requirement is correct
* The architecture is appropriate
* Authorization is complete
* Security risks are absent
* Production behavior is safe
* Important tests exist
* Regressions were not introduced
* Error handling is complete
* The implementation is maintainable
* The public contract remains compatible

Before final validation begins, verify that the applicable review skills have
been completed.

For every applicable review, record:

* Skill applied
* Scope reviewed
* Findings discovered
* Corrections applied
* Remaining findings
* Unresolved questions
* Review status

Do not proceed when:

* A Critical finding remains unresolved.
* A High finding remains unresolved.
* A material business-rule question remains unanswered.
* A public contract change has not been reviewed.
* A dependency change has not been reviewed.
* A migration lacks a rollback assessment.
* An important production flow cannot be investigated.
* The complete diff has not received a Staff PR review.

Final validation is the last gate, not the only gate.


## Implementation policy verification

Confirm English code/comments with preserved business and external contracts,
documentation authored for modified contracts, tests for new behavior with
mocked end-to-end boundaries, responsive verification for UI changes, and input
validation and sanitization on both frontend and backend where applicable.
Confirm security review covers every change and no known blocking security
findings remain. For affected error responses and logs, confirm `security-log`
was applied: no raw exceptions, stack traces, or enumeration clues reach
clients, internal diagnostics are preserved, and sensitive values are not logged.

When `CHANGE_LOG.md` exists, verify it records the planned version, main
changes, author, and date; when it does not, confirm none was created. Verify
application and lockfile version metadata agree and progress monotonically.
Confirm formatter and lint or equivalent checks ran across the configured scope
and that the complete final diff received Staff review after all fixes. No
AI-created commit or tag is part of this workflow.

## Scope, ownership, and risk

Confirm existing developer edits and staging state were preserved. Distinguish
pre-existing failures from new regressions, while keeping known blocking issues
visible. Verify the depth of Staff review matches the affected risks and that
migration, integrity, concurrency, and recovery checks were applied when needed.

Evaluate tests against acceptance criteria: they must exercise the real behavior
under test, use appropriate mock boundaries, and avoid snapshots or coverage
counts as the only evidence. Record which criteria remain unverified.

Validate documentation for modified contracts as part of the task. When the
project has no documentation tooling, confirm the developer was notified with
the reason and that no tool was added. Missing prose alone does not invalidate
an otherwise validated implementation. A contract that cannot be established
safely or a concrete security/correctness issue remains subject to the normal
blocking gate.

Keep review records internal when the host requires a concise findings-only
response; do not let this checklist override the Claude Staff output contract.

## Plan and approval evidence

For work governed by `implementation-plan`, confirm explicit approval preceded
implementation, the audit matches the approved revision when `CHANGE_LOG.md`
exists, and all material scope or risk changes received renewed approval before
dependent work. Confirm approver attribution is supported, tradeoffs and known
risks remain in history, and outcomes were appended without rewriting prior
acknowledgment.

Missing required approval blocks completion; do not manufacture evidence or
request retroactive approval as though it preceded implementation. For work
predating this policy, report the missing contemporaneous record honestly.
Approval is not evidence that a risk was resolved or that validation passed.

## Changed behavior

Confirm:

- The requested behavior was implemented.
- The implementation matches the full requirement.
- Existing behavior was preserved where required.
- Edge cases were considered.
- Failure behavior is intentional.
- No unrelated behavior was changed.

## Diff inspection

Review every changed file.

Check for:

- Accidental changes
- Debug statements
- Temporary code
- Commented-out code
- Hardcoded credentials
- Hardcoded environment values
- Unused imports
- Dead code
- Duplicate code
- Unsafe casts
- Broad types
- Missing error handling
- Sensitive logs
- Unnecessary dependency additions

## Automated validation

Discover and run the project's applicable commands, such as:

- Format check
- Lint
- Type checking
- Unit tests
- Integration tests
- End-to-end tests
- Build
- Dependency audit

Do not invent command names. Inspect project configuration first.

## Requirement traceability

Map each requirement to:

- The implementation that satisfies it
- The test or validation that verifies it

If a requirement has no validation, report it as a remaining risk.

## Final status

Classify the implementation as one of:

### Validated

All relevant checks were executed successfully.

### Partially validated

The implementation was completed, but one or more relevant checks could not be
executed.

### Not validated

Relevant checks failed or the environment prevented meaningful validation.

Never use `Validated` when tests, build, lint, or other applicable checks failed
or were not executed.

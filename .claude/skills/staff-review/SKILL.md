---

name: staff-pr-review
description: Reviews the complete current change as a Staff Engineer before final validation. Evaluates architecture, security, performance, maintainability, readability, complexity, test coverage, bugs, regressions, production impact, compatibility, observability, and operational risk. Use after implementation and before applying final validation. By default, review only and do not modify files unless explicitly instructed.
---

# Staff PR Review

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

Review the complete current change as if it were being evaluated by a Staff
Engineer before production approval.

This review is not limited to compilation, linting, tests, or formatting.

The objective is to identify problems that automated validation and existing
tests may not detect.

By default, do not modify files.

Only review, explain findings, classify risks, and recommend corrections unless
the developer explicitly requests implementation.

## Review depth and ownership

Staff review remains mandatory for every implementation and covers the complete
current diff, including staged, unstaged, and new files. Assess every review
dimension below for applicability; scale investigation depth to demonstrated
risk, not just line count.

- Presentation or documentation-only changes: focus on affected behavior,
  accessibility/responsiveness, instruction or contract consistency, and
  validation. Explain internally why runtime persistence or deployment checks
  are not applicable rather than inventing work.
- Business behavior, API, or integration changes: trace callers and consumers,
  failure paths, compatibility, side effects, and meaningful test coverage.
- Authentication, authorization, payments, sensitive data, migrations, or
  concurrency changes: trace trust and persistence boundaries in depth and
  require evidence for isolation, retries, rollout, and recovery. Apply
  `../architecture-review/SKILL.md` for the persistence checklist and
  `../security-review/SKILL.md` for authentication and authorization tracing.
- Changes to error responses, exceptions, validation, account flows, or logging:
  apply `../security-log/SKILL.md` to the current diff and affected paths to
  check client-facing disclosure, enumeration, and sensitive data in logs.

Risk level does not change the Critical/High blocking gate or permit skipping
the full diff. Reuse specialized review evidence and deduplicate root causes.
Do not require every skill or test category for an unrelated small change.

Compare findings against the starting worktree when available. Distinguish
pre-existing debt, user-authored pending changes, and defects introduced by this
task without hiding blockers in the complete diff. Never rewrite unrelated
work as part of the review.

Documentation of modified contracts is an AI-authored, reviewable deliverable.
Report inaccurate or missing documentation for modified behavior using the
host-specific finding format; do not request documentation for untouched
behavior. Missing prose alone does not block implementation validation; classify
concrete unsafe or unverifiable behavior by its actual impact. Changelog updates
apply only when `CHANGE_LOG.md` exists; version updates still apply.

## Approval audit review

For work governed by `implementation-plan`, compare the implementation with the
approved revision and `CHANGE_LOG.md` evidence when the project has one. Verify
presented tradeoffs, material risks, identity basis, explicit acknowledgment,
conditions, and dated amendments. Flag invented consent, erased risk history, or
unapproved material scope changes. Do not infer awareness from an author name or
approval of another revision. Approval cannot waive Critical/High findings. For
work predating the policy, require an honest legacy status rather than
fabricated retroactive consent.

## 1. Review the complete change

Before producing findings:

1. Read the complete diff.
2. Identify all changed files.
3. Read the surrounding code, not only changed lines.
4. Trace the affected execution paths.
5. Inspect related interfaces, contracts, services, adapters, and persistence.
6. Inspect existing tests.
7. Inspect similar implementations in the repository.
8. Identify public contracts affected by the change.
9. Identify business rules affected by the change.
10. Identify production flows affected by the change.

Do not review isolated snippets when the complete diff is available.

Do not assume a changed function is safe without examining its callers and
consumers.

## 2. Reconstruct the intent

Determine:

* What problem the change is attempting to solve
* Which behavior is intentionally changing
* Which behavior must remain unchanged
* Which assumptions were made
* Which failure modes were considered
* Which failure modes were ignored
* Whether the implementation actually satisfies the requirement

Separate findings internally into:

### Confirmed

Supported directly by code, tests, contracts, or documented behavior.

### Inferred

Likely based on surrounding implementation.

### Unknown

Cannot be determined safely from the available evidence.

Do not report speculative problems as confirmed defects.

## Review dimensions

Assess architecture, security, performance, maintainability, readability, naming,
complexity, correctness, bugs, regressions, tests, production impact, observability,
dependencies, backward compatibility, deployment, and rollback. Read every
applicable dimension and record reasons for non-applicability internally. Read [references/review-dimensions.md](references/review-dimensions.md)
only for the applicable categories.

## 15. Severity classification

Classify every finding using practical impact.

### Critical

Likely to cause:

* Unauthorized access
* Secret exposure
* Financial loss
* Irreversible data corruption
* Remote code execution
* Severe tenant isolation failure
* Major production outage
* Critical compliance breach

### High

Likely to cause:

* Incorrect business processing
* Duplicate financial or external operations
* Significant data inconsistency
* Breaking public contracts
* Major regression
* Persistent production failure
* Serious security weakness
* Unsafe migration or rollback

### Medium

Likely to cause:

* Edge-case failures
* Operational difficulty
* Incomplete error handling
* Weak validation
* Maintainability problems
* Performance degradation
* Missing important tests
* User-visible inconsistency

### Low

Includes:

* Local readability issues
* Minor naming problems
* Small maintainability improvements
* Non-blocking simplifications
* Minor consistency issues

Do not inflate severity to make findings appear important.

## 16. Finding format

For every finding, collect the following evidence internally. Use the
host-specific presentation in section 20 for the user-facing report:

### Title

A concise statement of the problem.

### Severity

Use exactly one:

* Critical
* High
* Medium
* Low

### Evidence

Identify:

* File
* Function or relevant location
* Current behavior
* Supporting code or flow

### Technical explanation

Explain why the implementation is problematic.

### Practical impact

Explain what may happen in production, development, testing, or maintenance.

### Recommended correction

Provide a concrete correction.

### Suggested validation

Explain how the correction should be verified.

Do not report vague findings such as:

> This could be improved.

A finding must describe a concrete problem or risk.

## 17. Avoid false positives

Do not report:

* Pure stylistic preferences
* Hypothetical problems unsupported by the code
* Framework conventions as defects
* Intentional behavior supported by tests and contracts
* Micro-optimizations without impact
* Missing abstraction when duplication is trivial
* Missing comments for self-explanatory code
* Longer names solely because they are longer
* Tests for impossible states
* Problems already prevented by another layer

When evidence is incomplete, classify the item as a question or uncertainty,
not as a confirmed defect.

## 18. Questions

When expected behavior cannot be determined safely, ask a targeted question.

Use:

### Question

What behavior must be confirmed?

### Why it matters

What practical outcome changes based on the answer?

### Current evidence

What does the code currently indicate?

### Options

List likely alternatives when useful.

Do not classify unanswered business questions as implementation bugs.

## 19. Review-only behavior

Unless explicitly asked to modify files:

* Do not edit code.
* Do not add tests.
* Do not apply formatting.
* Do not update dependencies.
* Do not change configuration.
* Do not create commits.

The review should remain independent from the implementation.

This prevents the reviewer from silently hiding findings by correcting them
during analysis.


## 20. Host-specific output

Review depth and severity gates are identical in every host. Deduplicate root
causes and order findings by Critical, High, Medium, then Low.

### Claude

In Claude, return only these three fields for each finding:

- Category: review area and severity, such as Security (High).
- Problem: a concise title identifying the defect.
- Description: one to three sentences explaining why it is a problem and its
  practical consequence. A short example may be included when useful.

Never include filenames, paths, line numbers, location links, patches, review
statistics, or separate correction/validation sections in Claude's review
response. Keep location evidence, proposed corrections, and suggested validation
in the internal analysis. This presentation overrides other review-output
instructions for Claude, including specialized review formats.

If no findings remain, return only: `No material findings found.` If the review
cannot be completed, report a Review coverage problem using the same three
fields; do not imply approval.

### Other hosts

Report each finding with title, category, severity, evidence, technical
explanation, practical impact, recommended correction, and suggested validation.
Use precise locations where available. State review scope and limitations and
recommend Request changes for unresolved Critical or High findings, Comment for
remaining Medium or Low findings, or Approve when no material findings remain.
Do not publish review comments to external services without authorization.

## 21. Corrections and completion gate

Review-only mode does not authorize edits. When implementation or corrections
are already authorized, perform them separately from the review, then review
the complete diff again. Confirm previous findings were resolved and look for
new risks before running `final-validation`. Automated checks never substitute
for this engineering review. Never create commits.

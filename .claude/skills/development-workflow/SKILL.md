---
name: development-workflow
description: Coordinate explicit plan approval, safe implementation, Staff review, and final validation for features, fixes, refactors, configuration, dependencies, migrations, documentation, and skill changes. Use before, during, and after every implementation.
---

# Development Workflow

Follow this workflow whenever implementing changes to code, configuration,
dependencies, migrations, documentation, or skills. Read-only reviews and
investigation do not themselves authorize implementation.

This workflow is mandatory. Do not consider an implementation complete until
all applicable validation steps have been performed.

## Preserve the working tree

Before editing, inspect staged, unstaged, and untracked changes and record the
starting state. Treat existing work as intentional. Read overlapping edits and
adapt the patch without replacing the developer's changes. Do not reset, clean,
stash, restore, stage, or unstage existing work without explicit authorization.
Avoid whole-file rewrites when a targeted edit can preserve unrelated content.
If concurrent edits appear, reread the affected content before applying changes.
Ask only when overlapping intentions cannot be reconciled safely; continue
independent work while that conflict is unresolved.

Separate pre-existing failures from regressions introduced by this task.
A dirty working tree alone is not a reason to stop or request approval.

## 1. Plan and obtain approval

Before editing any deliverable, apply `implementation-plan` from
`../implementation-plan/SKILL.md`. Investigate read-only, present the current
plan with alternatives, benefits, drawbacks, and risks, and wait for explicit
developer approval. After approval, record its evidence and acknowledged risks
in `CHANGE_LOG.md` before implementation when the project has one; never create
the file. Never infer approval from silence.

The investigation includes:

1. Apply `requirements-review` and define observable acceptance criteria.
2. Identify the affected modules, files, interfaces, and integrations.
3. Inspect existing implementations for similar behavior.
4. Identify existing project conventions.
5. Identify possible backward compatibility risks.
6. Identify unclear requirements or assumptions.

Do not start by creating new abstractions before inspecting the existing code.

## 2. Inspect the affected flow

Trace the complete flow when applicable:

- Entry point
- Input validation
- Authentication and authorization
- Business rules
- Persistence
- External integrations
- Error handling
- Logging
- Returned response
- Tests
- Documentation

Do not inspect only the file explicitly mentioned in the task.

## 3. Plan the smallest correct change

Prefer the smallest implementation that completely solves the problem.

Avoid:

- Unrelated refactors
- Premature abstractions
- New dependencies without clear necessity
- Duplicating existing utilities
- Changing public contracts unnecessarily
- Silently changing behavior outside the requested scope

## 4. Implement incrementally

Start only after the approved plan and evidence are recorded. A material scope
or risk change returns to `implementation-plan` before dependent implementation.
Do not treat approval as a waiver of unresolved Critical or High findings.

During implementation:

1. Follow existing project patterns.
2. Keep functions and classes focused.
3. Use clear and domain-oriented names.
4. Validate data at system boundaries.
5. Handle expected failure cases.
6. Preserve backward compatibility unless explicitly instructed otherwise.
7. Avoid exposing secrets or sensitive information.
8. Add or update tests with the implementation.

## 5. Apply the implementation policies

Apply `code-quality` for English code and documentation review, `testing` for
new behavior, `security-review` for every changed flow, and
`frontend-user-experience` for responsive screens when applicable. Apply
architecture and error-handling reviews where relevant. Apply `security-log` to
changes that touch error responses, exceptions, validation, authentication,
authorization, account flows, or logging, limited to the requested change.
Author documentation for modified contracts with `api-documentation` using the
project's existing tooling; when none exists, notify the developer instead of
adding one.

Documentation, tests, and corrections cover only what this task created or
modified, including existing behavior the change affects. Pre-existing code,
documentation, and tests outside that scope are not changed unless the user
requests it; report pre-existing blockers instead of correcting them.

Use the risk-based review depth in `staff-pr-review`. Assess every mandatory
review dimension for applicability, then investigate affected dimensions in
depth. Reuse evidence across skills rather than issuing duplicate checklists or
findings. Small changes still require the complete Staff review and applicable
checks, but do not justify unrelated investigations.

Apply `release-changelog` to update an existing `CHANGE_LOG.md` and the
application version before reviewing the complete change.

## 6. Format, lint, and review

Apply `lint-and-static-analysis`: discover and run the project's formatter and
lint or equivalent checks across the configured project scope. Inspect all
automatic changes. Report unavailable tooling and pre-existing failures.

After implementation and formatting, load `staff-pr-review` from
`../staff-review/SKILL.md` and review the complete current diff, including new
files, tests, documentation, version metadata, and formatting changes. The review
itself is read-only. Report findings to the user using its host-specific format.

Correct findings within the authorized implementation scope in a separate step.
Review the entire diff again after corrections, confirm resolution, and check
for new risks. Unresolved Critical or High findings block final validation.

## 7. Final validation

Only after the review gate, apply `final-validation` and run the applicable
format check, lint, type check, unit tests, mocked end-to-end tests, integration
tests, build, and project-specific checks. Any subsequent modification requires
another complete Staff review before final validation is repeated.

Never claim a command passed unless it actually succeeded. Report missing tools,
failed checks, and unverified behavior.

## Commit ownership

AI agents must never create commits, including amend operations or commands that
implicitly commit. The developer's responsibility is to review all changes and
create commits. A request to commit means preparing an English commit-message
suggestion and handing it to the user; do not execute the commit. Follow the
repository's established message convention, or Conventional Commits when none
exists. Never generate Portuguese commit messages. Version updates must not
invoke commands that create commits or tags automatically.

## 8. Report completion

The final response must contain:

### Implemented

Briefly describe what changed.

### Validated

List the commands and checks actually performed.

### Risks or limitations

Describe remaining risks, assumptions, skipped validations, or unverified
behavior.

Do not say that the task is fully validated when relevant checks were skipped
or failed. Report documentation that could not be produced, and why, separately
from implementation defects and validation failures.

## Improve the skills from evidence

After real tasks expose a missed defect, false positive, or conflicting rule,
identify the responsible skill and propose the smallest correction supported by
that evidence. Do not silently edit installed skills during application work.
When skill maintenance is requested, use a realistic scenario and check whether
the new instruction resolves the issue without expanding unrelated scope.
Prefer correcting an existing rule over adding another overlapping skill.

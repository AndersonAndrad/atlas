---

name: lint-and-static-analysis
description: Detects, analyzes, and fixes lint and static-analysis errors in any project that provides linting or static-analysis tooling. Use during every implementation when lint tooling exists. A task must not be considered complete while lint errors introduced or reachable in the affected project remain unresolved.
---

# Lint and Static Analysis

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

## Formatting and review ordering

Run the existing formatter and lint or equivalent static analysis over the
configured project scope for every implementation. Use safe formatting fixes
and inspect their diff; do not rewrite generated or vendored content. If no
tooling exists, report this and run available structural/whitespace checks
without claiming they replace a full linter.

Finish formatting before the read-only Staff review. If lint fixes change any
file after review, repeat the complete Staff review before final validation.

## Objective

Lint and static analysis are mandatory quality gates when the project provides
the necessary tooling.

The agent must not consider a task complete only because:

* The code compiles.
* Tests pass.
* The implementation appears correct.
* The changed files have no obvious syntax errors.

If the project has a lint or static-analysis command, it must be discovered and
executed before completion.

A task must not be reported as validated while applicable lint checks are
failing.

## Tool discovery and baseline

Use to discover the project's configured formatter/linter, establish a baseline,
and distinguish pre-existing debt from regressions. Never weaken checks to pass. Read [references/tool-discovery.md](references/tool-discovery.md)
only for the applicable categories.

## Safe lint corrections

Use when interpreting or correcting rule violations, unsafe types, promises,
React hooks, security warnings, complexity, auto-fixes, or ESLint configuration. Read [references/safe-corrections.md](references/safe-corrections.md)
only for the applicable categories.

## Project lint validation

Use for repository/CI scope, baseline debt, monorepos, generated files,
configuration changes, blocking failures, and truthful validation reports. Read [references/project-validation.md](references/project-validation.md)
only for the applicable categories.


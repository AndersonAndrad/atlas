# Tool discovery and baseline

Use to discover the project's configured formatter/linter, establish a baseline,
and distinguish pre-existing debt from regressions. Never weaken checks to pass.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 1. Discover the project's lint tooling

Before running commands, inspect the project configuration.

Possible sources include:

* `package.json`
* `Makefile`
* `Taskfile.yml`
* `pyproject.toml`
* `.eslintrc`
* `eslint.config.js`
* `eslint.config.mjs`
* `biome.json`
* `ruff.toml`
* `.golangci.yml`
* `pom.xml`
* `build.gradle`
* `checkstyle.xml`
* CI workflow files
* Project documentation

Identify:

* Lint command
* Static-analysis command
* Auto-fix command
* Scope
* File patterns
* Ignored paths
* Configuration inheritance
* CI behavior

Do not invent command names.

Use commands already defined by the project whenever possible.

## 2. Common tooling

Examples include:

### JavaScript / TypeScript

* ESLint
* Biome
* TypeScript compiler
* Stylelint

Possible commands:

```bash
npm run lint
npm run lint:fix
pnpm lint
yarn lint
npx eslint .
```

### Go

* golangci-lint
* go vet
* staticcheck

### Python

* Ruff
* Flake8
* Pylint
* mypy

### Java

* Checkstyle
* SpotBugs
* PMD

### C#

* Roslyn analyzers
* dotnet format

Use the tooling already adopted by the project.

Do not introduce another linter merely because the current one reports errors.

## 3. Mandatory execution

When lint tooling exists:

1. Run the applicable lint command.
2. Capture all reported errors and warnings.
3. Determine whether auto-fix is available.
4. Apply safe automatic fixes when appropriate.
5. Review all automatic changes.
6. Fix remaining issues manually.
7. Run lint again.
8. Repeat until no blocking lint errors remain.
9. Run the broader validation commands afterward.

Do not stop after the first lint execution.

Do not report the task as complete with known lint errors.

## 4. Existing lint debt

The repository may already contain lint failures before the current task.

Examples:

```text
219 problems
180 errors
39 warnings
```

Do not ignore them automatically.

First determine:

* Which errors are in files changed by the current task.
* Which errors existed before the task.
* Which errors prevent the project lint command from succeeding.
* Which errors are safe to correct within scope.
* Which errors represent repository-wide technical debt.

### Rule for changed files

All lint errors in files touched by the current task must be corrected.

The task must not introduce new lint errors.

The task must not leave existing lint errors in a modified area when they can be
safely corrected without unrelated behavioral changes.

### Repository-wide failures

When the configured project lint command fails because of pre-existing errors
outside the current task:

1. Record the baseline.
2. Separate pre-existing errors from newly introduced errors.
3. Fix all errors caused by the current implementation.
4. Fix nearby or directly related existing errors when safe.
5. Report remaining repository-wide lint debt explicitly.

If project policy requires zero lint errors globally, then continue correcting
the repository until lint passes completely.

Do not hide existing lint debt by narrowing the lint command unless the project
explicitly uses changed-file linting.

## 5. Default project policy

Unless the project explicitly defines another policy:

* New lint errors are forbidden.
* Modified files must finish with zero lint errors.
* Auto-fixable lint errors should be corrected.
* Errors that reveal real code defects must be corrected.
* Existing repository-wide lint debt must be reported.
* A project-wide lint command that is expected to pass in CI must pass before
  final validation.

When the repository currently contains large lint debt and the user explicitly
requires all lint errors fixed, treat the cleanup as part of the task.

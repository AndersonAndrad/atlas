# Project lint validation

Use for repository/CI scope, baseline debt, monorepos, generated files,
configuration changes, blocking failures, and truthful validation reports.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 18. Changed-file validation

During implementation, targeted lint may be used for speed.

Example:

```bash
eslint src/changed-file.ts
```

This is useful for iteration.

However, before final completion:

* Run the project-level lint command when practical.
* Do not rely only on changed-file lint when CI runs the entire repository.
* Compare results with the baseline if pre-existing debt exists.

## 19. Baseline comparison

When the repository already has lint failures, record:

```text
Before:
219 lint errors

After implementation:
223 lint errors
```

This is a regression and must not be accepted.

A valid progression may be:

```text
Before:
219 lint errors

After implementation:
214 lint errors
```

but if project policy requires lint to pass globally, continue until:

```text
0 lint errors
```

Report both before and after when existing debt is relevant.

## 20. CI consistency

Inspect CI workflows when possible.

Determine:

* Which lint command CI runs.
* Which Node or runtime version CI uses.
* Whether warnings fail CI.
* Whether formatting is checked separately.
* Whether generated code is linted.
* Whether multiple workspaces have separate lint commands.

Local validation must match CI expectations.

Do not claim lint validation is complete using a command different from the
one used by CI without explaining the difference.

## 21. Monorepos

In monorepos, determine:

* Root lint command
* Workspace-specific lint commands
* Affected applications
* Shared packages
* Dependency graph
* CI affected-project behavior

Run all applicable lint commands.

Do not lint only the application while modified shared packages remain
unchecked.

## 22. Generated files

Do not manually fix generated files unless the project expects them to be
edited.

If generated files fail lint:

1. Identify the generator.
2. Determine whether they should be ignored.
3. Determine whether the generated template is wrong.
4. Fix the source or generator when appropriate.

Do not add broad ignore rules without justification.

## 23. Lint configuration changes

Changes to lint configuration are engineering changes.

Review:

* Why the rule is changing.
* Which files are affected.
* Whether severity is being reduced.
* Whether new ignores are introduced.
* Whether a plugin is removed.
* Whether type-aware analysis is disabled.
* Whether CI behavior changes.

Any change that makes lint less strict requires explicit justification.

Do not weaken lint to make an implementation pass.

## 24. Required task workflow

For every task in a project with lint configured:

### Before implementation

When useful, run lint to establish a baseline.

### During implementation

Run targeted lint on changed areas.

### Before completion

Run the full applicable lint command.

### After automatic or manual fixes

Run lint again.

### Before final validation

Lint must be green according to project policy.

## 25. Blocking behavior

A lint failure blocks completion when:

* It was introduced by the current task.
* It exists in a modified file and can be safely corrected.
* It represents a correctness issue.
* It represents a security issue.
* It represents a type-safety issue.
* It represents a React Hooks violation.
* CI requires the lint command to pass.
* Project policy requires zero lint errors.

Do not mark the implementation `Validated` while a blocking lint failure
remains.

## 26. Required output

After lint review, report:

### Lint tooling

State which linter or static analyzer was discovered.

### Command executed

List the actual command.

### Baseline

When applicable, report the original number of:

* Errors
* Warnings

### Findings fixed

Summarize the categories corrected.

### Remaining findings

List any remaining findings and why they remain.

### After

Report the final:

* Error count
* Warning count

### Validation status

Use:

* Validated
* Partially validated
* Not validated

Use `Validated` only when the project's expected lint command passes according
to project policy.

## 27. Anti-patterns

Do not:

* Ignore lint because tests pass.
* Ignore lint because the task is unrelated.
* Introduce new lint errors.
* Leave lint errors in modified files.
* Run lint only once.
* Run only auto-fix and assume the task is complete.
* Use `eslint-disable` indiscriminately.
* Disable rules globally to make the build green.
* Replace real types with `any`.
* Add unsafe type assertions.
* Add `void` to promises without reviewing lifecycle.
* Remove dependencies from React hooks without analysis.
* Modify generated files blindly.
* Narrow the lint command only to hide repository failures.
* Ignore the command used by CI.
* Claim lint passed when it was not executed.
* Mark the task validated while blocking lint errors remain.

Lint is a mandatory engineering gate when the project provides it.

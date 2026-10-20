# Safe lint corrections

Use when interpreting or correcting rule violations, unsafe types, promises,
React hooks, security warnings, complexity, auto-fixes, or ESLint configuration.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 6. Do not disable rules to make lint pass

Do not solve lint errors by weakening lint configuration without analyzing the
root cause.

Avoid:

```ts
// eslint-disable-next-line
```

```ts
/* eslint-disable */
```

or configuration changes such as:

```js
rules: {
    'important-rule': 'off',
}
```

unless there is a specific and justified exception.

Before suppressing a rule:

1. Understand why the rule exists.
2. Determine whether the code can be corrected instead.
3. Determine whether the rule conflicts with project architecture.
4. Check existing project conventions.
5. Limit suppression to the smallest possible scope.
6. Document why suppression is necessary.

Do not globally disable a rule because one implementation violates it.

## 7. Do not change behavior only to satisfy lint

Lint corrections must preserve intended behavior.

Be careful when fixing:

* Missing dependencies in hooks
* Promise handling
* Async callbacks
* Equality comparisons
* Nullable values
* Unused parameters
* Type coercion
* Exhaustive dependencies
* Mutation warnings
* Unsafe optional chaining
* Accessibility rules
* React hooks
* Resource cleanup

A lint error may expose a real defect.

Do not silence it without understanding the behavior.

## 8. Unused variables and imports

Remove unused:

* Imports
* Variables
* Functions
* Parameters
* Types
* Interfaces
* Constants
* Components
* Helpers

unless they are required by a framework contract.

Do not rename unused values to `_value` merely to silence lint unless:

* The framework requires the parameter.
* The interface requires the signature.
* Project convention explicitly uses this pattern.

Prefer deleting unnecessary code.

## 9. Naming lint findings

When lint exposes unclear naming, apply the `naming-conventions-review` skill.

Examples:

```ts
const f = filter;
const d = data;
const x = result;
```

Do not keep poor names merely because the linter does not reject them.

Lint defines the minimum mechanical standard.

Naming and readability skills define the engineering standard.

## 10. Type-related lint findings

For rules such as:

* `no-explicit-any`
* unsafe assignment
* unsafe member access
* unsafe return
* unsafe argument

do not solve them using type assertions blindly.

Avoid:

```ts
value as any
value as unknown as SomeType
```

unless explicitly justified.

Instead:

1. Identify the real runtime type.
2. Validate external input.
3. Create the correct type.
4. Narrow unknown values.
5. Preserve boundary safety.

Do not trade lint cleanliness for weaker type safety.

## 11. Promise and async rules

Review findings involving:

* Floating promises
* Missing await
* Misused promises
* Async callbacks
* Promise rejection
* Error propagation

Do not fix a floating promise by adding:

```ts
void somePromise();
```

without confirming that fire-and-forget behavior is intentional.

Determine:

* Who owns the promise lifecycle?
* Does failure matter?
* Should it be awaited?
* Does it need timeout?
* Does it require retry?
* Does it need logging?
* Can it survive request cancellation?

Lint may expose an architectural issue.

## 12. React and frontend lint rules

When applicable, inspect:

* React Hooks rules
* Missing effect dependencies
* Invalid hook usage
* Accessibility rules
* Unstable references
* Missing keys
* Unsafe JSX
* Interactive element semantics

Do not silence:

```text
react-hooks/exhaustive-deps
```

without understanding why the dependency is missing.

A lint warning about effect dependencies may reveal:

* Infinite loops
* Stale closures
* Repeated network calls
* Incorrect state synchronization
* Unnecessary renders

Apply relevant frontend skills when needed.

## 13. Security lint findings

Treat findings involving security as more than style.

Examples:

* Unsafe eval
* Dynamic code execution
* Unsafe regex
* Unsanitized HTML
* Weak randomness
* Unsafe child process execution
* Path traversal
* Unsafe deserialization
* Missing promise handling around security operations

Apply `security-review` when lint exposes a security-sensitive issue.

## 14. Complexity lint findings

When the linter reports:

* Excessive cognitive complexity
* Excessive cyclomatic complexity
* Function too long
* Too many parameters
* Excessive nesting

do not split code mechanically.

First determine:

* Which responsibilities are mixed?
* Which conditions represent domain rules?
* Whether repeated logic should be extracted.
* Whether the complexity belongs to the domain.
* Whether a state machine or policy would be clearer.

Apply `code-quality` and `architecture-review`.

## 15. Auto-fix behavior

Auto-fix may be used for deterministic changes such as:

* Formatting
* Import ordering
* Semicolons
* Quotes
* Some unused imports
* Whitespace
* Safe syntax transformations

After auto-fix:

1. Inspect the diff.
2. Confirm no unintended behavior changed.
3. Run lint again.
4. Run type checking.
5. Run tests.
6. Run build when applicable.

Never assume `--fix` is behavior-preserving without reviewing the diff.

## 16. ESLint-specific guidance

For ESLint projects:

Inspect:

* Flat config versus legacy config
* Type-aware linting
* Parser configuration
* Project references
* Ignore patterns
* React plugins
* Import plugins
* Security plugins
* Accessibility plugins

Prefer the configured project command over direct ESLint invocation.

If:

```bash
npm run lint
```

runs:

```bash
eslint .
```

use the project script.

Do not bypass project configuration by linting only one file unless doing an
intermediate diagnostic run.

Final validation should use the actual project lint command.

## 17. Warnings

Determine the project's warning policy.

Possible policies:

* Warnings allowed
* Warnings fail CI
* `--max-warnings=0`
* Specific warning threshold

When the project treats warnings as failures, they must be fixed before
completion.

Even when warnings do not fail CI, review them.

Do not ignore security, correctness, or React Hooks warnings merely because
their severity is `warning`.

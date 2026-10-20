---
name: code-quality
description: Reviews new or modified code for readability, maintainability, duplication, unnecessary complexity, naming, typing, boundaries, and consistency with existing project conventions. Use after every production code change.
---

# Code Quality Review

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

Review all code created or modified during the current task.

## Implementation language and documentation review

Write all new code, identifiers, comments, docstrings, and technical documentation
in English. Preserve established business-rule names and external API field
names, values, and responses exactly when translation would change their meaning
or contract. Do not translate persisted identifiers or localized product copy
as an incidental cleanup.

The AI agent authors documentation for modified behavior using the project's
existing tooling, as defined in `api-documentation`. Keep comments, docstrings,
API descriptions, and relevant guides accurate for the modified code, and add
rationale for non-obvious behavior. Do not require comments for obvious code or
rewrite documentation of untouched behavior unless the user requests it.

This does not exempt executable schemas, validators, types, or configuration
from correctness: update behavior-bearing code within the implementation scope.
The explicitly required changelog and version metadata remain maintained by
`release-changelog`. Review reports are not application documentation.

## Project consistency

Before suggesting a new pattern:

1. Search for similar implementations.
2. Follow the existing project organization.
3. Reuse existing helpers and abstractions when appropriate.
4. Do not introduce a new convention without a clear benefit.

## Readability

Verify that:

- Names communicate business intent.
- Functions have one clear responsibility.
- Complex conditions are understandable.
- Control flow is not unnecessarily nested.
- Comments explain decisions, not obvious syntax.
- Constants replace unexplained magic values.
- Public behavior is understandable from the code.

## Complexity

Look for:

- Functions doing unrelated work
- Excessive branching
- Deep nesting
- Repeated conditions
- Duplicate transformations
- Premature abstractions
- Generic utilities used by only one call site
- Unnecessary indirection
- Hidden side effects

Prefer simple and explicit code over clever code.

## Types and contracts

Verify that:

- Types are specific and meaningful.
- Unsafe casts are avoided.
- Null and undefined cases are handled.
- Public contracts are not silently changed.
- Return values and failure behavior are predictable.
- DTOs and interfaces represent their real domain purpose.

Do not use broad types such as `any`, generic maps, or untyped objects when a
more accurate type can reasonably be defined.

## Duplication

Remove duplication only when the duplicated behavior represents the same
business concept.

Do not merge code merely because it looks structurally similar.

## Scope control

Confirm that the diff contains only changes required for the task.

Flag:

- Unrelated refactors
- Unrequested formatting changes
- Dependency upgrades
- Renaming outside the affected scope
- Public API changes
- Behavior changes without tests

### Naming and cognitive load

Check:

* Are names understandable without inspecting their types?
* Are parameters named after their domain meaning?
* Are abbreviations unnecessary or project-specific?
* Are single-letter names used for values with business meaning?
* Are generic names such as `data`, `item`, `value`, `object`, or `result`
  hiding more specific concepts?
* Does the reader need to search another file to understand an identifier?
* Do names distinguish similar concepts clearly?
* Are names still accurate after the implementation changed?

Prefer names that make the code understandable at first glance.

For example:

```ts
const loadList = async (filter: FitbankWebhookAuditFilter) => {}
```

is clearer than:

```ts
const loadList = async (f: FitbankWebhookAuditFilter) => {}
```

Do not request longer names mechanically.

Accept established abbreviations such as `id`, `url`, `api`, `http`, and
project-standard terms when they are clearer than their expanded forms.


## Completion criteria

The review is complete only when:

- The code follows existing patterns.
- The implementation is understandable.
- Unnecessary complexity has been removed.
- Relevant contracts remain stable.
- No unrelated changes remain.

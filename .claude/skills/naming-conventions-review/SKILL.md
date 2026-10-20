---
name: naming-conventions-review
description: Reviews naming consistency across files, folders, variables, constants, functions, methods, classes, interfaces, types, enums, DTOs, components, hooks, services, repositories, controllers, tests, routes, database objects, events, logs, metrics, environment variables, and public contracts. Use whenever creating, renaming, or modifying code, files, modules, APIs, schemas, or domain concepts.
---

---

# Naming Conventions Review

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

Review all names created or modified during the current task.

The objective is that a developer can understand the role, domain meaning, and
behavior of an identifier immediately, without needing to inspect distant code,
types, comments, callers, or implementation details.

Good naming reduces cognitive load, prevents incorrect reuse, exposes domain
boundaries, and makes inconsistencies easier to detect.

Do not optimize names for minimum character count.

Do not make names unnecessarily long.

Prefer the shortest name that communicates the complete relevant meaning.

## 1. Inspect project conventions first

Before creating or renaming identifiers:

1. Inspect neighboring files.
2. Inspect similar modules.
3. Inspect naming patterns already established by the project.
4. Inspect framework conventions.
5. Inspect language conventions.
6. Inspect test naming.
7. Inspect public API terminology.
8. Inspect database and external-provider terminology.
9. Identify inconsistent existing conventions.
10. Reuse the established convention when it is clear and valid.

Do not introduce a new naming convention in one isolated file.

When the project already contains conflicting conventions:

1. Identify the dominant convention.
2. Identify whether the difference is intentional.
3. Determine the canonical terminology.
4. Avoid adding a third convention.
5. Propose a focused migration when inconsistency creates real risk.

Do not copy an existing name blindly when it is misleading or incorrect.

## 2. General naming principles

Every name should answer at least one of these questions:

- What is this?
- What does it do?
- Which domain concept does it represent?
- Which state does it describe?
- Which unit or format does it use?
- Which scope does it belong to?
- Which direction does data flow?
- Is it input, output, request, response, command, query, event, or persistence?

A good name should be:

- Specific
- Accurate
- Consistent
- Searchable
- Pronounceable
- Domain-oriented
- Stable over time
- Appropriate for its scope
- Distinguishable from related concepts

Avoid names that require interpretation.

## Identifier and action naming

Use for abbreviations, variables, booleans, functions, classes, interfaces, DTOs,
controllers, services, and query/command distinctions. Read [references/identifiers-and-actions.md](references/identifiers-and-actions.md)
only for the applicable categories.

## Boundary, file, and UI naming

Use for repositories, guards, events, errors, constants, enums, files, folders,
components, hooks, and tests. Read [references/boundaries-and-files.md](references/boundaries-and-files.md)
only for the applicable categories.

## Contract and domain terminology

Use for persistence, migrations, environment settings, events, public/external
contracts, units, scope, legacy names, and canonical domain terminology. Read [references/contracts-and-domain.md](references/contracts-and-domain.md)
only for the applicable categories.

## 37. Naming review severity

Classify naming findings by practical impact.

### Critical

Rare for naming alone, but applicable when misleading names contribute directly
to:

- Authorization bypass
- Cross-tenant access
- Financial misrouting
- Secret exposure
- Data corruption

### High

Use when names may cause:

- Incorrect identity source usage
- Confusion between security principals
- Wrong identifier sent to an external system
- Incorrect permission checks
- Persistent contract misuse
- Data written to the wrong entity

### Medium

Use when names cause:

- Significant maintainability risk
- Repeated incorrect reuse
- Hidden side effects
- Confusing public contracts
- Duplicate concepts
- Difficult incident investigation

### Low

Use for:

- Local abbreviations
- Minor casing inconsistency
- Generic local names
- Small searchability improvements

Do not classify every naming issue as Low automatically.

Names can expose deeper architectural or security defects.

## 38. Review process

When applying this skill:

1. Inspect all changed files.
2. List every new or modified identifier.
3. Compare names with project conventions.
4. Search for the same concept across the repository.
5. Identify abbreviations.
6. Identify generic names.
7. Identify misleading names.
8. Identify duplicate terminology.
9. Identify casing inconsistencies.
10. Identify public-contract impact.
11. Identify persisted or external compatibility impact.
12. Rename local behavior-preserving identifiers when explicitly authorized.
13. Avoid broad unrelated renaming.
14. Run applicable lint, tests, type checking, and build after changes.
15. Review the final diff.

## 39. Required review output

Provide findings using the Staff PR Review format when possible.

Example:

```text
### `src/audit/use-webhook-audits.ts`

#### Replace the abbreviated filter parameter

**Lines:** 42-51
**Severity:** Low

**Review comment**

The parameter `f` represents a complete `FitbankWebhookAuditFilter`, but its
meaning is only discoverable by inspecting the type and function body.

**Impact**

This adds unnecessary cognitive load and makes future changes easier to
misinterpret.

**Suggested correction**

Rename `f` to `filter`.

Also consider renaming `loadList` to `loadWebhookAudits` if the surrounding
scope does not already make the list type explicit.
```

For each finding include:

- File
- Line range
- Current name
- Why it is unclear or incorrect
- Practical impact
- Suggested name
- Whether the rename is local or contract-breaking
- Required validation

## 40. Naming inventory

For larger changes, provide a focused inventory:

| Current name      | Suggested name              | Kind            | Scope                  | Reason                 | Compatibility risk |
| ----------------- | --------------------------- | --------------- | ---------------------- | ---------------------- | ------------------ |
| `f`               | `filter`                    | parameter       | local                  | Removes abbreviation   | None               |
| `data`            | `auditRecords`              | variable        | local                  | Reveals returned value | None               |
| `ownerID`         | `employerId`                | trace attribute | observability contract | Matches actual entity  | Medium             |
| `SuperAdminGuard` | `BackofficeSuperAdminGuard` | class           | internal API           | Clarifies actor scope  | Low                |

Do not create an inventory for trivial changes with one or two names.

## 41. Rename safety

Before renaming, classify the identifier.

### Local rename

Examples:

- Local variable
- Private method
- Internal parameter
- Non-exported helper

Usually safe after search and validation.

### Internal contract rename

Examples:

- Exported class
- Shared interface
- Public module function
- DI token
- Event consumed inside the repository

Requires full usage search and tests.

### Public contract rename

Examples:

- API field
- Route
- Webhook field
- Queue event name
- Environment variable
- Database column
- Published package export

Requires:

- Compatibility review
- Versioning
- Migration
- Deprecation
- Documentation
- Consumer analysis
- Rollback plan

Do not rename a public contract as a minor cleanup.

## 42. Anti-patterns

Do not:

- Use one-letter domain variables.
- Use abbreviations that require interpretation.
- Rename identifiers only to make them longer.
- Expand established terms mechanically.
- Use generic names when a domain name exists.
- Use inconsistent casing.
- Mix singular and plural.
- Hide units.
- Hide side effects.
- Reuse one DTO name for unrelated boundaries.
- Call different concepts by the same name.
- Call the same concept by several names.
- Use provider terminology throughout generic domain code.
- Use database terminology as the public API by default.
- Rename public contracts without compatibility analysis.
- Create broad `utils`, `helpers`, or `common` files without ownership.
- Accept misleading names because the code currently works.
- Ignore naming inconsistencies in authentication and authorization.
- Ignore names that represent the wrong identifier.
- Perform repository-wide renaming unrelated to the task.
- Report naming preferences without practical reasoning.

Good naming should allow the reader to understand the code at first glance and
reduce the chance of incorrect future changes.

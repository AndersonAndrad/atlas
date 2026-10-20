---
name: dependency-review
description: Reviews direct Node.js dependency pinning, lockfile consistency, update compatibility, and justified library version ranges. Use when adding or updating dependencies or reviewing dependency declarations.
---

# Dependency Review

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

## Exact dependency version pinning

Direct dependencies must use exact versions.

Prefer:

```json
{
  "dependencies": {
    "jose": "6.0.0",
    "class-validator": "0.14.2"
  },
  "devDependencies": {
    "typescript": "5.9.2"
  }
}
```

Avoid version ranges:

```json
{
  "dependencies": {
    "jose": "^6.0.0",
    "class-validator": "~0.14.2",
    "package-a": ">=2.0.0",
    "package-b": "*",
    "package-c": "latest"
  }
}
```

Do not use:

* Caret ranges such as `^1.2.3`
* Tilde ranges such as `~1.2.3`
* Greater-than or lower-than ranges
* Wildcards
* `latest`
* `next`
* `stable`
* Unpinned Git branches
* Unpinned Git tags
* Unpinned URLs

Every direct dependency must resolve from an explicitly reviewed version.

The approved version in `package.json` must match the version selected during
dependency review.

### Why exact versions are required

Semantic versioning does not guarantee that every minor or patch release is
behaviorally safe.

A package may introduce within the same major version:

* Runtime behavior changes
* New transitive dependencies
* Type definition changes
* Changed defaults
* Performance regressions
* Security regressions
* Build incompatibilities
* New installation scripts
* Framework compatibility problems
* Package ownership or provenance changes

Version ranges can cause a future installation or lockfile regeneration to
resolve a version that was never reviewed.

The lockfile improves reproducibility, but it does not replace exact direct
dependency declarations.

Exact versions provide defense when:

* The lockfile is regenerated
* A lockfile is accidentally removed
* A workspace resolves dependencies independently
* Automated update tooling modifies the dependency tree
* A package is installed in another environment
* A published package is consumed without the repository lockfile
* Different package-manager behavior is introduced

### Installation behavior

When adding a dependency, use the package-manager option that saves an exact
version.

Examples:

```bash
npm install --save-exact package-name@1.2.3
npm install --save-dev --save-exact package-name@1.2.3
pnpm add --save-exact package-name@1.2.3
pnpm add --save-dev --save-exact package-name@1.2.3
yarn add --exact package-name@1.2.3
yarn add --dev --exact package-name@1.2.3
```

Use the project package manager.

Do not manually change only `package.json` without regenerating and reviewing
the lockfile through the package manager.

### Package-manager configuration

When appropriate, configure the repository to save exact versions by default.

For npm or pnpm:

```ini
save-exact=true
```

This may be placed in the project `.npmrc`.

For Yarn, use the applicable project configuration or always install with the
exact-version option.

Before modifying package-manager configuration, verify that it does not conflict
with workspace or publication requirements.

### Existing version ranges

When reviewing a dependency change, inspect whether the affected direct
dependency currently uses a range.

When safely within the scope of the change:

1. Replace the range with the exact installed and reviewed version.
2. Regenerate the lockfile using the project package manager.
3. Confirm that the resolved dependency tree did not change unexpectedly.
4. Run applicable validation.

Do not convert every dependency in the repository as an unrelated change.

A repository-wide migration from ranges to exact versions must be handled as a
separate, explicit dependency-hardening change.

### Updates

Exact pinning does not mean dependencies should remain outdated.

Updates must be intentional.

For every update:

1. Select the exact target version.
2. Review release notes and advisories.
3. Review compatibility and breaking changes.
4. Apply the exact version.
5. Inspect the lockfile.
6. Run validation.
7. Record the reason for the update.

Automated dependency tools may propose updates, but the resulting version must
remain exact after approval.

### Exceptions

Do not apply exact-version rules mechanically to fields whose purpose is to
declare compatibility rather than installation.

Examples requiring separate review include:

* `peerDependencies`
* Package engines
* Supported framework ranges for published libraries
* Optional compatibility declarations

For application repositories, `dependencies` and `devDependencies` should use
exact versions.

For published libraries, `peerDependencies` may require a supported range so
consumers can use compatible framework versions.

Even in those cases:

* Use the narrowest justified range.
* Do not use wildcards.
* Document supported versions for modified ranges using existing project tooling.
* Test the minimum and maximum supported versions when applicable.

### Review checks

During dependency review, verify:

* Are all changed direct dependencies pinned exactly?
* Did the package manager insert `^` or `~` automatically?
* Does `.npmrc` enforce `save-exact=true`?
* Does the lockfile resolve the exact reviewed version?
* Did any workspace declare a different range?
* Did an automated tool introduce a non-exact version?
* Are Git dependencies pinned to an immutable commit?
* Are Docker images and CI actions pinned according to their own dependency
  policies?

Report a finding when a newly added or updated direct dependency uses a mutable
version range.

The default correction is to replace it with the exact reviewed version.

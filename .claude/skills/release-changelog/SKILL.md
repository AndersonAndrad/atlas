---
name: release-changelog
description: Update an existing CHANGE_LOG.md and application version metadata for each implementation, preparing an auditable next release without creating commits or tags. Skip changelog records when the project has no CHANGE_LOG.md. Use before Staff review and final validation.
---

# Release Changelog

For every implementation, after the developer approves the current plan under
`implementation-plan`, update the root `CHANGE_LOG.md` in English with the
intended post-commit application version, principal changes, author, and change
date in YYYY-MM-DD format. Preserve historical entries. Describe an uncommitted
release as planned, never as already committed or deployed.

## Changelog presence

Only maintain a changelog that already exists. When the project has no root
`CHANGE_LOG.md`, do not create it and do not write release or approval records
anywhere else; state in the completion report that no changelog exists. Version
metadata in an existing `package.json` still follows the rules below.

## Determine the next version

Inspect existing version metadata, changelog history, release tags, and project
release conventions. Follow the project's version scheme; for SemVer, use patch
for compatible fixes, minor for compatible features, and major for breaking
changes. Compare versions semantically, never lexicographically. The next
release must exceed the latest applicable released/current baseline; never
reduce a version or reuse a released version for different changes.

If this task already has an uncommitted version bump, update that planned release
summary instead of incrementing again on every review iteration. Preserve all
approved decision records; append amendments rather than rewriting them.
Reassess the increment if scope changes. Do not overwrite another contributor's
pending release.

If `package.json` exists, update the affected application's `version` and keep
corresponding lockfile root/workspace version metadata consistent using the
existing package manager without dependency upgrades. Respect independent
workspace releases; do not bump unrelated packages. Avoid lifecycle commands
that create commits or tags. Do not add a package manifest to a non-Node project.

Use the existing source of version truth. When an existing `CHANGE_LOG.md` has
no release history and no other version metadata exists, establish `0.1.0` as
an explicitly planned initial version in it. Ask only when competing sources
cannot be reconciled safely.

## Attribution and content

Use the configured Git `user.name` as the author name. The authenticated user
identity supplied by the AI host may complement it when available; never invent
an author. If neither exists, request attribution before finalizing the entry.
Use the current date in the user's/project's timezone.

Each entry must include:

- Version and planned/released status.
- Change date.
- Author.
- Main additions, fixes, and compatibility changes.

Changelog and version updates are explicitly required release bookkeeping and
remain automated. Application documentation for modified behavior is authored by
the AI agent under `api-documentation`. Do not confuse a release summary with
complete application documentation.

## Approval audit and release summary

When `CHANGE_LOG.md` exists, use `../implementation-plan/SKILL.md` as the
source of truth for the approval record schema. Append the approved plan,
presented benefits/drawbacks, risks, approver identity basis, and faithful
approval evidence before implementing it. Do not record a proposed or rejected
plan as approved, infer acknowledgment from Git configuration, or invent prior
informed consent.

Keep approved decisions append-only even while the release summary is planned.
Record later discoveries and validation outcomes as dated amendments, with
acknowledgment status stated truthfully. A new plan revision is an approved
amendment only after explicit approval. Preserve original risk descriptions and
link resolutions to their IDs. Use safe, redacted evidence appropriate to the
repository's visibility. A release summary may be updated without rewriting the
auditable decision history.

## Review and validation

Include the changelog, when present, and all version changes in the complete
Staff review.
Verify monotonic progression against the baseline, agreement between applicable
manifests and locks, accurate attribution/date, and preservation of history.
Do not create commits or tags. Offer an English commit-message suggestion only
when requested, using the project convention or Conventional Commits.

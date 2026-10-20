---
name: implementation-plan
description: Prepare and present an action plan with alternatives, benefits, drawbacks, and risks before any implementation. Require explicit developer approval of the current plan and preserve an evidence-based approval audit in CHANGE_LOG.md, when the project has one, before execution. Use for features, fixes, refactors, configuration, dependencies, migrations, documentation, and skill changes.
---

# Implementation Plan and Approval

Before implementing any change, investigate the request, present a concrete
plan, and wait for the developer's explicit approval of that plan. A request to
build something authorizes investigation and planning, not acceptance of risks
that have not yet been presented. Approval must identify the current revision
and its scope; silence, elapsed time, or lack of objections is never approval.

## 1. Investigate without implementing

Read the repository, existing changes, requirements, public contracts, tests,
and relevant documentation. Apply `requirements-review` to establish observable
acceptance criteria, uncertainty, compatibility obligations, and validation.
Read-only investigation and non-mutating checks may proceed before approval.
Do not edit deliverables, install dependencies, apply formatting, change version
metadata, or execute migrations before approval. Keep the proposal in the
conversation until approved; do not create a plan file as a workaround.

Reuse the current conversation's existing approved plan when its scope and
risks still match. Do not request repeated approval for already approved work.

## 2. Present a concrete proposal

Give the plan a stable identifier and revision, for example PLAN-001 revision 1.
Present a concise but complete proposal proportional to the change:

- Objective, scope, exclusions, and observable acceptance criteria.
- Ordered implementation steps, affected contracts, and validation approach.
- Viable alternatives, including leaving behavior unchanged when relevant.
- Benefits and drawbacks of the proposed approach and material alternatives.
- All identified material risks, failure modes, security/privacy concerns,
  compatibility breaks, data risks, dependency impact, and operational costs.
- Rollout, rollback or recovery approach when applicable.
- Assumptions, unresolved questions, mitigations, and residual risks.

Use stable risk identifiers, such as R1, with severity, evidence, practical
impact, mitigation, and residual status. Distinguish confirmed defects,
plausible risks, and unknowns. If documentation appears to imply unsafe behavior,
trace the affected contract and explain the causal connection; do not blame the
developer or state that their documentation caused a defect without evidence.

Do not claim to have identified every possible flaw or promise a flawless
feature. Explicitly state relevant uncertainty. An absent risk list means no
material risks were identified in the investigated scope, not that none exist.

## 3. Obtain approval of this revision

Ask the developer to approve or revise the identified plan. Use the configured
Git `user.name` as the approver name; the authenticated user identity supplied
by the AI host may complement it when available. Ask for a name only when
neither exists. Record the identity basis: Git configuration and host identity
are attribution sources, not independent proof of who approved.

For material residual risks, ask for explicit acknowledgment of their risk IDs
as part of the approval. A short confirmation is sufficient only when it
unambiguously answers the current plan and its approval question. A conditional
approval applies only after the stated conditions are satisfied; if they change
the plan materially, present a revised plan and obtain approval again.

If the developer reformulates, rejects, or asks questions about the proposal,
revise it and repeat the assessment. Do not implement or write an approval entry
for an unapproved revision. Keep useful read-only work moving while awaiting a
required answer. Approval tools or chat may capture the response, but neither
an automatically selected option nor an approval request is approval evidence.

## 4. Record the approved decision before implementation

After approval, apply `release-changelog` to append an approval audit under the
planned release in `CHANGE_LOG.md`. When the project has no `CHANGE_LOG.md`, do
not create one or record the audit elsewhere; the explicit approval in the
conversation remains required, and implementation may proceed. Record:

- Plan identifier, revision, objective, scope, and approved steps.
- Approval timestamp with timezone, separately from the implementation date.
- Approver name and identity basis; distinguish approver from change author.
- Approval evidence: message reference when available and a faithful short
  quotation. Never fabricate a message identifier or approval timestamp; use
  an explicitly labeled recording timestamp if the source time is unavailable.
- The benefits, drawbacks, and alternatives actually presented.
- Risk IDs, severity, evidence, impacts, mitigations, residual risks, and unknowns
  presented with that revision, including security and compatibility concerns.
- Which risks were explicitly acknowledged, the evidence of acknowledgment,
  any conditions, and the validation/rollout/recovery commitments.
- Decision status, initially Approved for implementation, not Implemented or
  Validated. Report blockers separately; approval does not resolve them.

Use English for authored audit prose. Preserve source quotations faithfully in
their original language; label translations as translations. Summarize sensitive
evidence safely and redact secrets, credentials, personal data beyond necessary
attribution, and exploitable details inappropriate for the repository. Reference
an authorized restricted record when available; never invent one.

Do not state that the developer understood every consequence, assumed legal
liability, or accepted an unmentioned risk. Record observable presentation and
explicit acknowledgment, not inferred mental state or blanket consent.

## 5. Preserve history and respect engineering gates

Treat approved decision records as append-only. Add dated amendments, superseding
revisions, implementation outcomes, and validation results; never silently
rewrite the original approval or replace a known risk with its resolved state.
Risk resolution should reference the original risk ID and supporting evidence.
Keep ordinary release-summary edits separate from the immutable decision history.

Approval does not waive unresolved Critical or High findings, security review,
Staff review, tests, or final validation. Include corrections to known blocking
risks in the plan; do not proceed with a knowingly unsafe implementation merely
because a developer accepted the risk. A discovered blocker stops dependent
work while a safe correction is planned; independent authorized work may proceed.

A materially different scope, contract, tradeoff, or newly discovered material
risk requires a revised proposal and explicit approval before dependent changes.
Ordinary corrections already covered by the approved scope and risk assessment
do not require repeated approval. Record subsequent discoveries and outcomes
truthfully without inventing acknowledgment; only label an amendment approved
after the developer actually approves it.

Do not backfill informed approval for work predating this policy. Legacy work
may be labeled as lacking a contemporaneous approval record. A changelog is a
repository record of the conversation, not tamper-proof or independently
verified proof of consent. Do not publish it externally or create commits.

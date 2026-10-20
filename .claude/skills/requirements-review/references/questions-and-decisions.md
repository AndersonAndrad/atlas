# Questions and decisions

Use when ambiguity materially affects behavior or safety. Preserve the
implementation-plan approval gate even when clarification is unnecessary.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 19. Risk classification

Classify identified requirement risks as:

### Critical

Unclear behavior may cause:

* Security compromise
* Financial loss
* Data corruption
* Unauthorized access
* Irreversible effects
* Major production outage

### High

Unclear behavior may cause:

* Incorrect business processing
* Duplicate operations
* Significant user impact
* Breaking public contracts
* Persistent data inconsistency

### Medium

Unclear behavior may cause:

* Edge-case failure
* Weak validation
* Poor error handling
* Operational difficulty
* Incomplete user experience

### Low

Unclear behavior mainly affects:

* Minor usability
* Local consistency
* Readability
* Non-blocking improvements

Do not inflate severity.

## 20. Ask targeted questions

Ask questions only when the answer can materially change the implementation.

Each question must contain:

### Question

A direct question about the expected behavior.

### Why this matters

The concrete technical or business risk.

### Current evidence

What the repository or requirement currently indicates.

### Options

Likely alternatives when they help the developer answer.

Example:

### Question

Should whitespace be removed from every string field or only from explicitly
classified textual fields?

### Why this matters

Trimming every string can silently modify passwords, tokens, signatures,
encoded values, and free-form content.

### Current evidence

The current requirement mentions unnecessary spaces but does not define which
fields may be normalized.

### Options

1. Trim only explicitly configured fields.
2. Trim all fields except an exclusion list.
3. Reject surrounding spaces in selected fields.
4. Preserve all values and validate individually.

Do not ask:

* Questions already answered by the code
* Generic questions without explaining the risk
* Questions about minor style choices
* Questions whose answer does not affect implementation
* Dozens of low-value questions

Prioritize Critical and High uncertainty.

## 21. Safe assumptions

When minor details remain unclear, prefer existing project conventions.

Safe assumptions may include:

* Reusing the existing error format
* Following the current naming pattern
* Reusing the existing design system
* Using established test tools
* Following the current folder structure
* Preserving public behavior
* Avoiding new dependencies

Do not treat the following as safe assumptions:

* Permission rules
* Financial behavior
* Destructive behavior
* Retry safety
* Data normalization
* Public contract changes
* State transitions
* Sensitive data handling
* Migration behavior
* External provider guarantees

## 22. Review output

Before implementation, provide:

## Requirement summary

Summarize the desired outcome without copying the task verbatim.

## Confirmed behavior

List the behavior supported by evidence.

## Assumptions

List inferred behavior that can safely follow project conventions.

## Material questions

Ask only questions that must be answered before implementation.

## Acceptance criteria

Provide testable criteria based on the confirmed requirement.

## Affected areas

List the likely implementation scope.

## Risks

List relevant risks by severity.

## Proposed validation

Describe the tests and checks that should prove the implementation.

## 23. After receiving answers

After the developer responds:

1. Map each answer to the related question.
2. Update the confirmed behavior.
3. Remove invalid assumptions.
4. Update the acceptance criteria.
5. Update implementation scope.
6. Identify remaining risks.
7. Proceed with the smallest complete implementation.
8. Apply the relevant development skills.
9. Validate the implementation against the acceptance criteria.

Do not ask the same question again after it was answered.

## 24. When clarification questions are unnecessary

Proceed directly to presenting the implementation plan without a requirements
interview when:

* The requirement is explicit.
* Existing behavior clearly defines the rule.
* Tests and contracts remove ambiguity.
* The change is small and non-behavioral.
* Remaining uncertainty can safely follow project conventions.

Do not turn every task into a requirements interview. This does not skip the
explicit plan approval required by `implementation-plan` before implementation.

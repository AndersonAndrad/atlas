---
name: frontend-user-experience
description: Reviews and improves frontend interfaces, forms, accessibility, interactions, validation, masks, loading states, errors, responsiveness, keyboard navigation, visual feedback, and user experience. Use whenever creating or modifying pages, components, forms, buttons, links, inputs, modals, menus, tables, dialogs, or any user-facing interface.
---

# Frontend User Experience

Before implementing changes from this skill, follow the approval gate in
`../implementation-plan/SKILL.md`. Read-only analysis and review may proceed
without implementation approval.

Apply this skill whenever creating or modifying something visible or
interactive in the frontend.

Do not consider a frontend task complete only because the interface renders.

The interface must also be understandable, accessible, predictable,
responsive, and safe to interact with.

## 1. Inspect the existing design

Before modifying the interface:

1. Inspect similar components already used by the project.
2. Reuse the existing design system when available.
3. Reuse existing components, tokens, spacing, typography, and interaction patterns.
4. Avoid introducing a new visual convention without necessity.
5. Verify whether the project already has form, input, button, modal, toast,
   loading, and validation components.

Do not duplicate components that already exist.

## Responsive implementation is mandatory

Every new or changed screen must remain usable from the smallest to the largest
viewport, including widths between design breakpoints. Follow the project's
style guide, components, design tokens, and breakpoint conventions. Use fluid
layouts, wrapping, and bounded content widths instead of one fixed canvas.

Verify narrow mobile, tablet, desktop, and wide screens, breakpoint boundaries,
orientation changes, text zoom, long content, and loading/error states. Prevent
clipping, overlapping controls, and page-wide horizontal scrolling; intentionally
scrollable tables must remain accessible. Add responsive behavior tests and
inspect representative viewports. Report the sizes actually checked and any
unverified range instead of claiming every resolution was tested.

## Interaction and accessibility

Use for semantic elements, clickable controls, buttons, keyboard behavior,
focus management, and accessible interaction. Read [references/interaction-and-accessibility.md](references/interaction-and-accessibility.md)
only for the applicable categories.

## Forms and validation

Use for input fields, normalization, masks, frontend validation, safe error
messages, and accessible error feedback; the server must validate independently. Read [references/forms-and-validation.md](references/forms-and-validation.md)
only for the applicable categories.

## States, layout, and visual behavior

Use for loading/empty/error/success states, dialogs, tables, responsive layout,
motion, touch behavior, frontend security, performance, and UI test selection. Read [references/states-and-layout.md](references/states-and-layout.md)
only for the applicable categories.

## 26. Final frontend checklist

Before finishing, verify all applicable items.

### Interaction

- [ ] Clickable elements use appropriate semantic elements.
- [ ] Clickable elements have clear visual feedback.
- [ ] Hover states exist when relevant.
- [ ] Focus-visible states exist.
- [ ] Disabled states work correctly.
- [ ] Loading prevents accidental duplicate actions.
- [ ] Icon-only controls have accessible names.

### Forms

- [ ] Inputs have visible labels.
- [ ] Input types and autocomplete values are correct.
- [ ] Masks accept typing, editing, and pasting.
- [ ] Frontend and backend validation are compatible.
- [ ] Error messages are specific and actionable.
- [ ] Errors are associated with their fields.
- [ ] Input normalization is domain-safe.
- [ ] Passwords, tokens, and secrets are not silently trimmed.

### Accessibility

- [ ] The flow is usable with a keyboard.
- [ ] Focus order is logical.
- [ ] Focus is visible.
- [ ] Colors have adequate contrast.
- [ ] Information does not depend only on color.
- [ ] Dynamic feedback is announced when appropriate.
- [ ] Reduced-motion preferences are respected when applicable.

### Experience

- [ ] Loading states are intentional.
- [ ] Empty states are intentional.
- [ ] Error states provide recovery.
- [ ] Success feedback is shown when needed.
- [ ] Destructive actions communicate consequences.
- [ ] Responsive behavior was considered.
- [ ] Touch interactions do not depend on hover.

### Validation

- [ ] Relevant tests were added or updated.
- [ ] Lint was executed when available.
- [ ] Type checking was executed when available.
- [ ] Frontend tests were executed when available.
- [ ] Build was executed when applicable.
- [ ] The final diff was reviewed.

## 27. Final report

Report:

### UX improvements

Describe the user-facing improvements.

### Accessibility

Describe the accessibility checks and changes performed.

### Forms and validation

Describe masks, normalization, validation, and error behavior.

### Validation performed

List only commands and checks that were actually executed.

### Remaining limitations

State what was not tested, could not be verified, or remains dependent on
manual validation.

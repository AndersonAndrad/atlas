# States, layout, and visual behavior

Use for loading/empty/error/success states, dialogs, tables, responsive layout,
motion, touch behavior, frontend security, performance, and UI test selection.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 13. Loading states

Every asynchronous action must communicate progress when the delay is
noticeable.

Use the appropriate loading pattern:

- Button loading state
- Skeleton
- Spinner
- Progress indicator
- Inline status
- Optimistic update
- Background refresh indicator

During loading:

- Prevent duplicate submissions when needed.
- Preserve user-entered data.
- Avoid unexpected layout shifts.
- Keep the user informed.
- Allow cancellation for long-running operations when practical.

Do not display a full-page loader for a small local action.

## 14. Empty states

Collections and result areas must have intentional empty states.

Differentiate:

- No data exists yet
- No search results were found
- Filters removed all results
- Data failed to load
- The user lacks permission
- The feature is unavailable

An empty state should explain the situation and provide the next useful action
when possible.

Do not render a blank screen.

## 15. Success feedback

Provide confirmation when the result is not visually obvious.

Examples:

- Saved successfully
- Copied to clipboard
- Item removed
- Message sent
- Upload completed
- Settings updated

Avoid success messages when the updated UI already makes the result completely
clear.

Do not use a toast as the only confirmation for a critical operation when the
state must remain visible.

## 16. Destructive actions

For destructive or irreversible actions:

- Use a clear label.
- Explain the consequence.
- Distinguish the action visually.
- Request confirmation when accidental activation would be harmful.
- Prefer undo when practical.
- Prevent repeated execution.
- Preserve context if the operation fails.

Avoid vague labels such as `Confirmar` in destructive dialogs.

Prefer labels such as:

- `Excluir usuário`
- `Cancelar pedido`
- `Remover integração`

## 17. Modals and dialogs

A modal must:

- Have an accessible title.
- Have a clear purpose.
- Move focus inside when opened.
- Keep focus within the modal while open.
- Close through an explicit action.
- Support Escape when dismissal is allowed.
- Return focus to the triggering element.
- Prevent background interaction.
- Avoid losing unsaved user data accidentally.

Do not use a modal when inline content or a dedicated page would be simpler.

## 18. Tables and lists

For data tables:

- Use correct table semantics.
- Provide meaningful column headers.
- Keep actions understandable.
- Avoid hiding essential information only on hover.
- Provide empty, loading, and error states.
- Make horizontal overflow usable on smaller screens.
- Preserve important context on responsive layouts.
- Label icon-only actions.

For large datasets, consider:

- Pagination
- Virtualization
- Filtering
- Sorting
- Search
- Result count
- Loading performance

Do not render an unbounded collection.

## 19. Responsive behavior

Verify the interface at relevant viewport sizes.

Check:

- Text does not overflow.
- Buttons remain reachable.
- Forms remain usable.
- Modals fit the viewport.
- Tables have an intentional mobile strategy.
- Touch targets are sufficiently large.
- Fixed elements do not hide content.
- Virtual keyboard behavior does not block important fields.
- Horizontal scrolling is intentional rather than accidental.

Do not treat desktop shrinking as a complete mobile design.

## 20. Motion and animation

Animations should explain state changes, not delay the user.

Verify:

- Motion is subtle and purposeful.
- Animations do not block interaction.
- Loading animation does not create unnecessary distraction.
- Reduced-motion preferences are respected.
- No essential information depends on animation.
- Repeated animation can stop.

Use `prefers-reduced-motion` when the project supports motion.

## 21. Contrast and color

Verify:

- Text has sufficient contrast.
- Disabled content remains understandable.
- Focus indicators are visible.
- Error and success states do not rely only on color.
- Links are distinguishable from surrounding text.
- Placeholder text remains readable but visually secondary.
- Light and dark themes remain usable when supported.

Do not assume a color is accessible because it looks visually distinct.

## 22. Touch experience

For touch interfaces:

- Use adequately sized touch targets.
- Keep sufficient spacing between destructive and common actions.
- Do not rely only on hover.
- Avoid gestures without visible alternatives.
- Ensure menus and dropdowns remain usable.
- Use appropriate mobile input modes.

Hover can enhance desktop experience but must not be required to discover or
use essential functionality.

## 23. Performance experience

Avoid frontend behavior that makes the interface feel slow.

Review:

- Unnecessary renders
- Large assets
- Layout shifts
- Blocking requests
- Repeated API calls
- Missing request cancellation
- Expensive calculations during input
- Heavy components loaded before needed
- Unbounded lists
- Images without appropriate dimensions

Do not optimize prematurely, but avoid obvious user-facing performance
problems.

## 24. Frontend security

Check:

- User-provided HTML is not rendered unsafely.
- Sensitive values are not logged.
- Tokens are not exposed unnecessarily.
- Error messages do not leak internal data.
- Authorization is not enforced only by hiding UI elements.
- External links use safe behavior when opening a new tab.
- File previews and uploads are handled safely.
- URLs derived from user input are validated.

Hiding a button does not replace backend authorization.

## 25. Tests

Add or update tests for important user behavior.

When applicable, test:

- Form submission
- Validation messages
- Invalid fields
- Keyboard interaction
- Loading states
- Disabled behavior
- Error responses
- Success responses
- Masked input
- Pasted input
- Value normalization
- Modal focus behavior
- Responsive behavior
- Accessible name and role
- Regression scenarios

Prefer tests based on what the user sees and does.

Avoid tests that depend unnecessarily on internal component implementation.

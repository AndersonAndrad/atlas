# Interaction and accessibility

Use for semantic elements, clickable controls, buttons, keyboard behavior,
focus management, and accessible interaction.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 2. Semantic HTML

Use native semantic elements whenever possible.

Prefer:

- `button` for actions
- `a` for navigation
- `label` associated with form fields
- `form` for form submission
- `nav` for navigation
- `main` for main content
- `header` and `footer` for their respective regions
- headings in a logical hierarchy
- lists for collections of related items

Do not use a generic `div` or `span` as a button when a native `button`
can be used.

If a custom interactive element is unavoidable, it must implement:

- Keyboard interaction
- Appropriate role
- Accessible name
- Focus behavior
- Disabled behavior
- Screen reader semantics

## 3. Clickable elements

Every clickable element must clearly appear interactive.

Verify:

- The correct semantic element is used.
- The element has a visible hover state when hover is supported.
- The element has a visible keyboard focus state.
- The element has an active or pressed state when applicable.
- Disabled elements look disabled.
- Disabled elements cannot be activated.
- The cursor communicates interactivity when appropriate.
- The clickable area is sufficiently large.
- Nested clickable elements are avoided.

Use `cursor: pointer` for custom clickable elements when it improves clarity.

Do not use `cursor: pointer` as a substitute for semantic HTML.

Prefer a native `button` or `a` before adding click behavior to a generic
element.

## 4. Buttons

Every button must have a clear purpose.

Verify:

- The label describes the action.
- Icon-only buttons have an accessible name.
- The button type is explicitly defined inside forms.
- Submit buttons use `type="submit"`.
- Non-submit buttons use `type="button"`.
- Destructive actions are visually and textually distinguishable.
- Critical destructive actions request confirmation when appropriate.
- Loading buttons prevent repeated submissions.
- Disabled buttons communicate why the action is unavailable when necessary.

Buttons should support the applicable states:

- Default
- Hover
- Focus-visible
- Active
- Loading
- Disabled
- Success or completed, when relevant

A hover state should provide noticeable feedback, such as:

- Background color change
- Border color change
- Text color change
- Subtle elevation
- Underline for links
- Small visual movement when consistent with the design system

Do not use an aggressive animation for routine actions.

Do not rely only on color to communicate state.

## 5. Keyboard navigation

All functionality must be usable without a mouse when reasonably applicable.

Verify:

- Interactive elements are reachable using `Tab`.
- Focus order follows the visual and logical order.
- Focus is visible.
- Enter and Space activate the appropriate controls.
- Escape closes dismissible dialogs, menus, and overlays when appropriate.
- Focus does not become trapped unintentionally.
- Modals intentionally trap focus while open.
- Focus returns to the triggering element after closing a modal.
- Hidden elements are not keyboard-focusable.

Do not add positive `tabindex` values such as `tabindex="1"`.

Prefer native browser focus behavior.

## 6. Focus states

Do not remove focus outlines without providing an accessible replacement.

Use `:focus-visible` when supported by the project.

A valid focus state must:

- Be clearly visible
- Have sufficient contrast
- Not depend only on a subtle color variation
- Work on light and dark backgrounds
- Be consistent across interactive components

# Forms and validation

Use for input fields, normalization, masks, frontend validation, safe error
messages, and accessible error feedback; the server must validate independently.

This reference supplements the parent skill. It does not authorize edits,
commits, publication, or automatic documentation authorship. The approved-plan
gate and the Staff review host-specific output contract remain authoritative.

## 7. Forms

Every form field must have:

- A visible label
- A stable field name
- The correct input type
- The correct autocomplete value when applicable
- Clear required or optional indication
- Validation feedback
- Accessible error association
- Predictable keyboard behavior

Placeholder text must not replace the label.

Use placeholders only for examples or additional hints.

Examples:

- `email` for email fields
- `tel` for telephone fields
- `password` for password fields
- `number` only when numeric increment behavior is appropriate
- `inputmode="numeric"` for numeric text entry that must preserve formatting
- `autocomplete="email"` for email
- `autocomplete="current-password"` for existing passwords
- `autocomplete="new-password"` for password creation
- `autocomplete="one-time-code"` for verification codes

Do not disable autocomplete without a real security or domain reason.

## 8. Input normalization

Normalize input only when the domain allows it.

Before trimming or transforming a value, classify the field.

### Usually safe to trim at the boundaries

Examples:

- Email
- Personal name
- City
- State
- Address fields
- Search query
- Company name
- Simple username, when spaces are not allowed
- Optional short text fields where surrounding spaces have no meaning

Prefer trimming leading and trailing whitespace.

Do not automatically remove meaningful spaces inside a value.

### Do not trim or normalize blindly

Examples:

- Password
- Access token
- Refresh token
- API key
- Cryptographic signature
- Hash
- Encoded value
- Verification code when formatting is meaningful
- File content
- Rich text
- Free-form message
- Secret
- Provider-specific identifier
- Data that must be compared byte-for-byte

Do not mutate a password silently.

If passwords with leading or trailing spaces are prohibited, reject them with
an explicit validation message instead of silently changing them.

### Normalization rules

When normalization is appropriate:

1. Perform it at a clearly defined boundary.
2. Keep frontend and backend behavior consistent.
3. Avoid applying normalization in multiple layers unpredictably.
4. Test the normalized and non-normalized scenarios.
5. Report undocumented input transformations for the developer to explain.

Do not change casing unless the field is explicitly case-insensitive.

## 9. Input masks

Use an input mask only when it improves data entry.

A mask must not become the source of truth for validation.

Verify:

- The user can paste values with or without formatting.
- Backspace and Delete behave naturally.
- Selection replacement works.
- Mobile keyboard behavior is appropriate.
- The cursor does not jump unexpectedly.
- Existing values can be edited.
- The raw value can be extracted reliably.
- Screen readers can understand the field.
- The field remains usable without JavaScript when applicable.
- The backend validates the actual domain value.

Common masked fields may include:

- CPF
- CNPJ
- CEP
- Telephone
- Dates
- Currency
- Bank information

Do not use a mask for fields whose format varies significantly between
countries or providers unless the context is restricted.

Store and transmit either the normalized or formatted value according to the
project contract.

Do not assume the formatted value is valid merely because it matches the mask.

## 10. Validation

Validation must help the user correct the problem.

Provide validation:

- At the appropriate time
- Near the affected field
- With a clear and specific message
- Without exposing internal implementation details
- Without deleting the user's input unnecessarily

Avoid showing errors before the user has had a reasonable chance to interact
with the field.

When applicable, validate:

- Required fields
- Minimum and maximum length
- Allowed format
- Allowed values
- Numeric ranges
- Date ranges
- File type and size
- Cross-field rules
- Duplicate values
- Business restrictions

Frontend validation improves experience but does not replace backend validation.

## 11. Error messages

Error messages must explain:

1. What went wrong
2. Which field or action was affected
3. What the user can do next

Prefer:

- `Informe um e-mail válido.`
- `A senha deve conter pelo menos 8 caracteres.`
- `Não foi possível salvar. Revise os campos destacados.`
- `Não conseguimos concluir o pagamento. Tente novamente.`

Avoid:

- `Erro`
- `Inválido`
- `Bad request`
- `500`
- Internal exception messages
- Raw provider errors
- Stack traces
- Technical identifiers without explanation

Preserve useful backend validation messages when they are safe and
understandable. Specific messages apply to documented public validation;
authentication, registration, and account-recovery flows follow the generic
responses defined in `../../security-log/SKILL.md`.

Map technical errors to user-friendly messages.

## 12. Error accessibility

When a field has an error:

- Apply an error state consistently.
- Associate the error message with the field.
- Use `aria-invalid="true"` when appropriate.
- Use `aria-describedby` to connect the input and error text.
- Do not communicate the error using color alone.
- Move focus to the first invalid field after an unsuccessful submission when
  this improves usability.
- Provide an error summary for large forms when appropriate.

Dynamic global errors should be announced using an appropriate live region.

Do not overuse assertive announcements.

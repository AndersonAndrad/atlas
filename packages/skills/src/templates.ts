import type { SkillTemplate } from '@atlas/contracts';

interface TemplateDefinition extends SkillTemplate {
  /** SKILL.md body, after the frontmatter. */
  body: string;
}

/** Version of the built-in templates; raised whenever their text changes. */
export const TEMPLATE_VERSION = '1.0.0';

const TEMPLATES: TemplateDefinition[] = [
  {
    id: 'conventional-commits',
    name: 'Conventional Commits',
    description:
      'Write commit messages that follow Conventional Commits 1.0.0. Use when preparing or reviewing a commit message.',
    version: TEMPLATE_VERSION,
    body: `# Conventional Commits

1. Read the staged changes (\`git diff --cached\`) before writing the message.
2. Use \`<type>(<optional scope>): <description>\` with a type such as feat, fix, docs,
   refactor, test, build, ci, perf or chore.
3. Keep the description imperative, lowercase and without a final period.
4. Explain *why* in the body when it is not obvious; wrap lines at 72 characters.
5. Mark breaking changes with \`!\` after the type and a \`BREAKING CHANGE:\` footer.
6. Never commit on your own: propose the message and let the user commit.
`,
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description:
      'Review a code change for correctness, readability, tests and risks. Use when asked to review a diff, a branch or a pull request.',
    version: TEMPLATE_VERSION,
    body: `# Code Review

1. Read the complete diff and the code around it, including callers and tests.
2. Look for bugs first: wrong conditions, missing error handling, races, broken contracts.
3. Then readability, naming, duplication and unnecessary complexity.
4. Check that tests cover the changed behavior, including failure paths.
5. Report each finding with severity, the problem and why it matters; do not rewrite code
   unless asked.
`,
  },
  {
    id: 'security-review',
    name: 'Security Review',
    description:
      'Review changes for security problems: input validation, authorization, secrets and injection. Use for changes touching user input, permissions, credentials or external calls.',
    version: TEMPLATE_VERSION,
    body: `# Security Review

1. Trace untrusted input from where it enters to where it is used.
2. Check validation, output encoding and parameterized queries; look for command and path
   injection.
3. Verify authentication and authorization use validated context, never client input.
4. Look for secrets in code, logs and error messages.
5. Classify findings by exploitability and impact, and propose the smallest safe fix.
`,
  },
  {
    id: 'unit-testing',
    name: 'Unit Testing',
    description:
      'Write focused unit tests for new or changed behavior. Use when adding features, fixing bugs or refactoring code that needs coverage.',
    version: TEMPLATE_VERSION,
    body: `# Unit Testing

1. Follow the project's existing test framework, folder layout and naming.
2. Test behavior, not implementation details; one reason to fail per test.
3. Cover the normal case, boundaries, invalid input and error paths.
4. Keep tests deterministic: fake clocks, ids and external services.
5. Run the tests and report the actual results; never claim tests pass without running them.
`,
  },
  {
    id: 'integration-testing',
    name: 'Integration Testing',
    description:
      'Write integration tests that exercise components together with real or faithful dependencies. Use for persistence, APIs and cross-module flows.',
    version: TEMPLATE_VERSION,
    body: `# Integration Testing

1. Identify the boundary under test (database, filesystem, HTTP, process).
2. Prefer real local dependencies (temporary databases or folders) over mocks.
3. Mock only what cannot run locally, and say so in the test name or comment.
4. Clean up every resource the test creates.
5. Run the tests and report results, including skipped ones and why.
`,
  },
  {
    id: 'documentation',
    name: 'Documentation',
    description:
      'Update documentation for changed behavior using the project’s existing tools. Use when public behavior, APIs, configuration or commands change.',
    version: TEMPLATE_VERSION,
    body: `# Documentation

1. Find where the project documents this behavior (README, docs/, OpenAPI, comments).
2. Document only what changed; keep the existing style and structure.
3. Explain what the user can do, its limits and how to verify it.
4. Keep examples runnable and free of secrets.
5. Do not add a new documentation system without asking.
`,
  },
  {
    id: 'architecture-analysis',
    name: 'Architecture Analysis',
    description:
      'Analyze the architecture affected by a change: boundaries, dependencies, data flow and trade-offs. Use before larger features, refactors or new integrations.',
    version: TEMPLATE_VERSION,
    body: `# Architecture Analysis

1. Map the modules involved and the direction of their dependencies.
2. Describe the data flow and where state is stored.
3. Identify boundary violations, coupling and duplicated responsibilities.
4. Present options with benefits, drawbacks and risks; recommend one.
5. Separate confirmed facts from assumptions.
`,
  },
];

export function listTemplates(): SkillTemplate[] {
  return TEMPLATES.map(({ body: _body, ...template }) => template);
}

/** SKILL.md for a new skill created from a template. */
export function templateSkillFile(templateId: string, name: string): string | null {
  const template = TEMPLATES.find((item) => item.id === templateId);
  if (template === undefined) return null;
  const description = template.description.replace(/"/g, '\\"');
  return [
    '---',
    `name: ${name}`,
    `description: "${description}"`,
    'metadata:',
    `  version: "${template.version}"`,
    `  template: ${template.id}`,
    '---',
    '',
    template.body,
  ].join('\n');
}

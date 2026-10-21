import { describe, expect, it } from 'vitest';
import type { Skill, SkillValidation } from '@atlas/contracts';
import {
  analyzeSkill,
  contentHash,
  diffFiles,
  diffLines,
  listTemplates,
  parseSkillFile,
  resolveSkill,
  templateSkillFile,
  toDirName,
  type SkillFolderSnapshot,
} from '../src/index.js';

const env = (executables: string[] = ['git']) => ({
  hasExecutable: (name: string) => executables.includes(name),
  skillNames: new Set(['base-skill']),
  now: new Date('2026-10-20T00:00:00.000Z'),
});

const snapshot = (
  skillMd: string | null,
  overrides: Partial<SkillFolderSnapshot> = {},
): SkillFolderSnapshot => ({
  dirName: 'review-helper',
  files: [
    {
      path: 'SKILL.md',
      size: skillMd?.length ?? 0,
      hash: 'a'.repeat(64),
      mode: 0o644,
      head: '---',
    },
  ],
  skillMd,
  openaiYaml: null,
  texts: [],
  problems: [],
  ...overrides,
});

const codes = (validation: SkillValidation) => validation.issues.map((issue) => issue.code);
const compat = (validation: SkillValidation, provider: 'claude' | 'codex') =>
  validation.compatibility.find((item) => item.provider === provider)!;

describe('parseSkillFile', () => {
  it('reads the frontmatter, also with a blank first line, BOM and CRLF', () => {
    const parsed = parseSkillFile(
      '﻿---\r\n\r\nname: staff-pr-review\r\ndescription: >\r\n  Reviews\r\n  changes\r\n---\r\n# Body\r\n',
    );
    expect(parsed.error).toBeNull();
    expect(parsed.fields).toEqual({ name: 'staff-pr-review', description: 'Reviews changes\n' });
    expect(parsed.body).toBe('# Body\n');
  });

  it('rejects deeply nested YAML without crashing (GHSA-48c2-rrv3-qjmp)', () => {
    const depth = 50_000;
    const nested = `---\nname: ${'['.repeat(depth)}${']'.repeat(depth)}\n---\n`;
    expect(() => parseSkillFile(nested)).not.toThrow();
    expect(parseSkillFile(nested).error).not.toBeNull();
  });

  it('reports missing closing lines, invalid YAML and non-mappings', () => {
    expect(parseSkillFile('---\nname: x\n').error).toContain('closing');
    expect(parseSkillFile('---\nname: [x\n---\n').error).toContain('not valid YAML');
    expect(parseSkillFile('---\n- a\n---\n').error).toContain('not a mapping');
    expect(parseSkillFile('# no frontmatter').hasFrontmatter).toBe(false);
    expect(parseSkillFile('---\n---\nbody').fields).toEqual({});
  });
});

describe('analyzeSkill (FR-617, FR-620, FR-621)', () => {
  it('accepts a skill both providers can use and keeps the folder name usable', () => {
    const analysis = analyzeSkill(
      snapshot(
        '---\nname: Review Helper\ndescription: Reviews diffs.\nmetadata:\n  version: "2.1.0"\n---\nBody',
      ),
      env(),
    );
    expect(analysis.validation.valid).toBe(true);
    expect(analysis.version).toBe('2.1.0');
    expect(analysis.dirName).toBe('review-helper');
    expect(compat(analysis.validation, 'claude').status).toBe('compatible');
    expect(compat(analysis.validation, 'codex').status).toBe('compatible');
    expect(codes(analysis.validation)).toContain('name-differs');
  });

  it('reports provider-specific features instead of converting them', () => {
    const analysis = analyzeSkill(
      snapshot(
        '---\nname: commit\ndescription: Commit.\nallowed-tools: Bash(git add *) Bash(git commit *) Read\ndisable-model-invocation: true\n---\n',
        {
          openaiYaml:
            'interface:\n  display_name: Commit\ndependencies:\n  tools:\n    - type: mcp\n      value: github\n',
        },
      ),
      env(['git']),
    );
    const codex = compat(analysis.validation, 'codex');
    expect(codex.status).toBe('partial');
    expect(codex.unsupportedFeatures).toEqual(['allowed-tools', 'disable-model-invocation']);
    const claude = compat(analysis.validation, 'claude');
    expect(claude.status).toBe('partial');
    expect(claude.unsupportedFeatures).toEqual(['agents/openai.yaml']);
    expect(analysis.validation.permissions).toEqual([
      'Claude Code pre-approved tool: Bash(git add *)',
      'Claude Code pre-approved tool: Bash(git commit *)',
      'Claude Code pre-approved tool: Read',
      'Codex tool dependency: mcp github',
    ]);
    expect(analysis.validation.dependencies).toEqual([
      { kind: 'executable', name: 'git', status: 'available', detail: null },
      {
        kind: 'tool',
        name: 'github',
        status: 'unknown',
        detail: 'Provided by the AI provider; not checked.',
      },
    ]);
  });

  it('marks what each provider refuses as incompatible', () => {
    const noFrontmatter = analyzeSkill(snapshot('# Just markdown'), env());
    expect(noFrontmatter.validation.valid).toBe(true);
    expect(compat(noFrontmatter.validation, 'codex').status).toBe('incompatible');
    expect(compat(noFrontmatter.validation, 'claude').status).toBe('compatible');

    const reserved = analyzeSkill(
      snapshot('---\nname: anthropic-skills:x\ndescription: d\n---\n'),
      env(),
    );
    expect(compat(reserved.validation, 'claude').status).toBe('incompatible');
    const synced = analyzeSkill(
      snapshot('---\nname: s\ndescription: d\n---\n', { dirName: 'Synced' }),
      env(),
    );
    expect(compat(synced.validation, 'claude').issues.map((issue) => issue.code)).toContain(
      'reserved-folder',
    );
    const long = analyzeSkill(
      snapshot(`---\nname: s\ndescription: ${'x'.repeat(1600)}\n---\n`),
      env(),
    );
    expect(compat(long.validation, 'claude').issues.map((issue) => issue.code)).toContain(
      'long-description',
    );
  });

  it('flags scripts, shell commands, hooks and missing dependencies without running anything', () => {
    const analysis = analyzeSkill(
      snapshot(
        '---\nname: s\ndescription: d\nhooks:\n  PreToolUse: []\nmetadata:\n  requires:\n    executables: [jq, git]\n    skills: [base-skill, other-skill]\n    providers: [codex, gemini]\n---\nContext: !`git status`\n',
        {
          files: [
            { path: 'SKILL.md', size: 10, hash: 'a'.repeat(64), mode: 0o644, head: '---' },
            { path: 'scripts/run', size: 10, hash: 'b'.repeat(64), mode: 0o755, head: 'echo' },
            { path: 'tool', size: 10, hash: 'c'.repeat(64), mode: 0o644, head: '#!/bin/sh' },
            { path: 'helper.py', size: 10, hash: 'd'.repeat(64), mode: 0o644, head: 'print' },
            { path: 'notes.md', size: 10, hash: 'e'.repeat(64), mode: 0o644, head: '#' },
          ],
        },
      ),
      env(['git']),
    );
    expect(analysis.validation.scripts).toEqual(['scripts/run', 'tool', 'helper.py']);
    expect(analysis.validation.permissions).toEqual([
      'Claude Code hooks (commands run on events)',
      'Claude Code runs the `!` shell commands of SKILL.md when invoked',
    ]);
    expect(
      analysis.validation.dependencies.map((item) => [item.kind, item.name, item.status]),
    ).toEqual([
      ['executable', 'jq', 'missing'],
      ['executable', 'git', 'available'],
      ['skill', 'base-skill', 'available'],
      ['skill', 'other-skill', 'missing'],
      ['provider', 'codex', 'available'],
      ['provider', 'gemini', 'unknown'],
    ]);
  });

  it('refuses credentials in metadata and warns about them elsewhere', () => {
    const inMetadata = analyzeSkill(
      snapshot(
        '---\nname: s\ndescription: uses token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n---\n',
      ),
      env(),
    );
    expect(inMetadata.validation.valid).toBe(false);
    expect(codes(inMetadata.validation)).toContain('credential-in-metadata');
    const inText = analyzeSkill(
      snapshot('---\nname: s\ndescription: d\n---\n', {
        texts: [
          { path: 'example.env', content: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456' },
        ],
      }),
      env(),
    );
    expect(inText.validation.valid).toBe(true);
    expect(codes(inText.validation)).toContain('possible-credential');
  });

  it('refuses folders without SKILL.md, with read problems or over the limits', () => {
    expect(analyzeSkill(snapshot(null), env()).validation.valid).toBe(false);
    const linked = analyzeSkill(
      snapshot('---\nname: s\ndescription: d\n---\n', {
        problems: [{ level: 'error', code: 'link-outside', message: 'x links outside' }],
      }),
      env(),
    );
    expect(linked.validation.valid).toBe(false);
    const big = analyzeSkill(
      snapshot('---\nname: s\ndescription: d\n---\n', {
        files: [
          { path: 'SKILL.md', size: 6 * 1024 * 1024, hash: 'a'.repeat(64), mode: 0, head: '' },
        ],
      }),
      env(),
    );
    expect(codes(big.validation)).toContain('too-large');
  });

  it('hashes content independently of order and slugs names for folders', () => {
    const files = [
      { path: 'b', hash: '1' },
      { path: 'a', hash: '2' },
    ];
    expect(contentHash(files)).toBe(contentHash([...files].reverse()));
    expect(contentHash(files)).not.toBe(contentHash([{ path: 'a', hash: '3' }, files[0]!]));
    expect(toDirName('Café  Review!')).toBe('cafe-review');
    expect(toDirName('***')).toBe('skill');
  });
});

describe('templates (FR-625)', () => {
  it('provides the seven versioned templates, each a valid skill for both providers', () => {
    const templates = listTemplates();
    expect(templates.map((item) => item.id)).toEqual([
      'conventional-commits',
      'code-review',
      'security-review',
      'unit-testing',
      'integration-testing',
      'documentation',
      'architecture-analysis',
    ]);
    for (const template of templates) {
      const text = templateSkillFile(template.id, template.id)!;
      const analysis = analyzeSkill(snapshot(text, { dirName: template.id }), env());
      expect(analysis.validation.valid, template.id).toBe(true);
      expect(analysis.version).toBe('1.0.0');
      for (const item of analysis.validation.compatibility) expect(item.status).toBe('compatible');
    }
    expect(templateSkillFile('missing', 'x')).toBeNull();
  });
});

describe('diff', () => {
  it('compares lines and files', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd').lines).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
    expect(diffLines('x\n'.repeat(3000), 'y').truncated).toBe(true);
    const file = (path: string, hash: string) => ({ path, hash, size: 1, script: false });
    expect(diffFiles([file('a', '1'), file('b', '1')], [file('a', '2'), file('c', '1')])).toEqual([
      { path: 'a', change: 'changed' },
      { path: 'b', change: 'removed' },
      { path: 'c', change: 'added' },
    ]);
  });
});

describe('resolveSkill (FR-619)', () => {
  const valid = analyzeSkill(snapshot('---\nname: s\ndescription: d\n---\n'), env()).validation;
  const skill = (overrides: Partial<Skill> = {}): Skill => ({
    id: '00000000-0000-4000-8000-000000000001',
    name: 's',
    description: 'd',
    dirName: 's',
    version: '1',
    currentSequence: 1,
    source: { kind: 'path', path: '/x', templateId: null },
    enabled: false,
    assignments: [],
    validation: valid,
    storagePath: '/data/s/1',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  });
  const rule = (
    scope: 'project' | 'provider' | 'role' | 'session',
    target: string,
    effect: 'enable' | 'disable',
  ) => ({
    skillId: '00000000-0000-4000-8000-000000000001',
    scope,
    target,
    effect,
    createdAt: '',
  });
  const project = '00000000-0000-4000-8000-0000000000aa';
  const session = '00000000-0000-4000-8000-0000000000bb';
  const decide = (value: Skill, context: Parameters<typeof resolveSkill>[1]) => {
    const result = resolveSkill(value, context, '/data/s/1/SKILL.md');
    return [result.active, result.layer];
  };

  it('applies security, restrictions, session, role, project/provider and global in order', () => {
    expect(decide(skill(), {})).toEqual([false, 'none']);
    expect(decide(skill({ enabled: true }), {})).toEqual([true, 'global']);
    expect(decide(skill({ enabled: true, validation: { ...valid, valid: false } }), {})).toEqual([
      false,
      'security',
    ]);

    const restricted = skill({
      enabled: true,
      assignments: [rule('project', project, 'disable'), rule('role', 'qa', 'enable')],
    });
    // A project restriction wins over everything but security, even session choices.
    expect(
      decide(restricted, { projectId: project, role: 'qa', sessionSkillIds: [restricted.id] }),
    ).toEqual([false, 'project']);
    expect(decide(restricted, { role: 'qa' })).toEqual([true, 'role']);

    const scoped = skill({
      assignments: [rule('project', project, 'enable'), rule('role', 'security', 'disable')],
    });
    expect(decide(scoped, { projectId: project })).toEqual([true, 'project']);
    expect(decide(scoped, { projectId: project, role: 'security' })).toEqual([false, 'role']);
    expect(
      decide(scoped, { projectId: project, role: 'security', sessionSkillIds: [scoped.id] }),
    ).toEqual([true, 'session']);
    expect(decide(scoped, {})).toEqual([false, 'none']);

    const sessionRule = skill({
      enabled: true,
      assignments: [rule('session', session, 'disable')],
    });
    expect(decide(sessionRule, { sessionId: session })).toEqual([false, 'session']);

    const providers = skill({ enabled: true, assignments: [rule('provider', 'codex', 'disable')] });
    expect(decide(providers, { provider: 'codex' })).toEqual([false, 'provider']);
    expect(decide(providers, { provider: 'claude' })).toEqual([true, 'global']);
    expect(
      decide(skill({ assignments: [rule('provider', 'claude', 'enable')] }), {
        provider: 'claude',
      }),
    ).toEqual([true, 'provider']);
  });

  it('never activates a skill for a provider that cannot use its format', () => {
    const claudeOnly = analyzeSkill(snapshot('# no frontmatter'), env()).validation;
    expect(decide(skill({ enabled: true, validation: claudeOnly }), { provider: 'codex' })).toEqual(
      [false, 'security'],
    );
    expect(
      decide(skill({ enabled: true, validation: claudeOnly }), { provider: 'claude' }),
    ).toEqual([true, 'global']);
  });
});

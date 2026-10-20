import { describe, expect, it } from 'vitest';
import { AtlasError } from '@atlas/shared';
import {
  CreateProjectInputSchema,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_TAGS_MAX_COUNT,
  UpdateProjectInputSchema,
  parseInput,
} from '../src/index.js';

const validCreate = { name: 'Atlas', workspacePath: '/work/atlas' };

describe('CreateProjectInputSchema', () => {
  it('accepts the minimal required fields and defaults tags', () => {
    expect(parseInput(CreateProjectInputSchema, validCreate)).toEqual({ ...validCreate, tags: [] });
  });

  it('trims the name and description but never the workspace path', () => {
    const parsed = parseInput(CreateProjectInputSchema, {
      name: '  Atlas  ',
      description: '  hello  ',
      workspacePath: '/work/ with space ',
    });
    expect(parsed.name).toBe('Atlas');
    expect(parsed.description).toBe('hello');
    expect(parsed.workspacePath).toBe('/work/ with space ');
  });

  it.each([
    ['empty name', { ...validCreate, name: '   ' }, 'name'],
    ['missing name', { workspacePath: '/x' }, 'name'],
    ['too long name', { ...validCreate, name: 'a'.repeat(PROJECT_NAME_MAX_LENGTH + 1) }, 'name'],
    ['missing path', { name: 'x' }, 'workspacePath'],
    ['blank path', { ...validCreate, workspacePath: '   ' }, 'workspacePath'],
    ['NUL byte in path', { ...validCreate, workspacePath: '/a\0b' }, 'workspacePath'],
    ['non-string tags', { ...validCreate, tags: [1] }, 'tags.0'],
    ['invalid tag characters', { ...validCreate, tags: ['<script>'] }, 'tags.0'],
    [
      'too many tags',
      {
        ...validCreate,
        tags: Array.from({ length: PROJECT_TAGS_MAX_COUNT + 1 }, (_, i) => `t${i}`),
      },
      'tags',
    ],
    ['unknown field', { ...validCreate, id: 'injected' }, '_'],
  ])('rejects %s', (_label, input, field) => {
    try {
      parseInput(CreateProjectInputSchema, input);
      expect.unreachable('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasError);
      const atlasError = error as AtlasError;
      expect(atlasError.code).toBe('VALIDATION_FAILED');
      expect(atlasError.issues.map((issue) => issue.field)).toContain(field);
    }
  });

  it('removes case-insensitive duplicate tags keeping the first spelling', () => {
    const parsed = parseInput(CreateProjectInputSchema, {
      ...validCreate,
      tags: ['Web', ' web ', 'api', 'API'],
    });
    expect(parsed.tags).toEqual(['Web', 'api']);
  });
});

describe('UpdateProjectInputSchema', () => {
  it('requires at least one field', () => {
    expect(() => parseInput(UpdateProjectInputSchema, {})).toThrow(AtlasError);
  });

  it('accepts null to clear the description', () => {
    expect(parseInput(UpdateProjectInputSchema, { description: null })).toEqual({
      description: null,
    });
  });

  it('rejects privileged or unknown fields', () => {
    expect(() =>
      parseInput(UpdateProjectInputSchema, { name: 'x', createdAt: '2020-01-01T00:00:00.000Z' }),
    ).toThrow(AtlasError);
  });
});

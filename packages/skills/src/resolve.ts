import type {
  AgentRole,
  AiProvider,
  ResolvedSkill,
  Skill,
  SkillAssignment,
  SkillScope,
} from '@atlas/contracts';
import { usableBy } from './analyze.js';

export interface ResolutionContext {
  projectId?: string | undefined;
  provider?: AiProvider | 'generic' | undefined;
  role?: AgentRole | undefined;
  sessionId?: string | undefined;
  /** Skills chosen for this session only (not stored). */
  sessionSkillIds?: readonly string[] | undefined;
}

type Layer = ResolvedSkill['layer'];

const rule = (
  assignments: readonly SkillAssignment[],
  scope: SkillScope,
  target: string | undefined,
) =>
  target === undefined
    ? undefined
    : assignments.find((item) => item.scope === scope && item.target === target);

/**
 * Decides whether a skill is active, by precedence (FR-619):
 * 1. mandatory security policies (invalid or unusable skills are never active);
 * 2. project and provider restrictions (`disable`);
 * 3. session configuration; 4. agent role configuration;
 * 5. project and provider enablement, then the global default.
 * The first rule that applies decides, and the reason says which one.
 */
export function resolveSkill(
  skill: Skill,
  context: ResolutionContext,
  skillFile: string,
): ResolvedSkill {
  const decide = (active: boolean, layer: Layer, reason: string): ResolvedSkill => ({
    skillId: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    active,
    layer,
    reason,
    skillFile,
  });
  const { assignments } = skill;
  const provider = context.provider === 'generic' ? undefined : context.provider;

  if (!skill.validation.valid) {
    return decide(false, 'security', 'The skill failed validation and cannot be activated.');
  }
  if (provider !== undefined && !usableBy(skill.validation, provider)) {
    return decide(false, 'security', `The skill's format is not usable by ${provider}.`);
  }
  if (rule(assignments, 'project', context.projectId)?.effect === 'disable') {
    return decide(false, 'project', 'Disabled for this project.');
  }
  if (rule(assignments, 'provider', provider)?.effect === 'disable') {
    return decide(false, 'provider', `Disabled for ${provider}.`);
  }
  if (context.sessionSkillIds?.includes(skill.id)) {
    return decide(true, 'session', 'Chosen for this session.');
  }
  const session = rule(assignments, 'session', context.sessionId);
  if (session) {
    return decide(
      session.effect === 'enable',
      'session',
      `${session.effect === 'enable' ? 'Enabled' : 'Disabled'} for this session.`,
    );
  }
  const role = rule(assignments, 'role', context.role);
  if (role) {
    return decide(
      role.effect === 'enable',
      'role',
      `${role.effect === 'enable' ? 'Enabled' : 'Disabled'} for the ${context.role} role.`,
    );
  }
  if (rule(assignments, 'project', context.projectId)?.effect === 'enable') {
    return decide(true, 'project', 'Enabled for this project.');
  }
  if (rule(assignments, 'provider', provider)?.effect === 'enable') {
    return decide(true, 'provider', `Enabled for ${provider}.`);
  }
  if (skill.enabled) return decide(true, 'global', 'Enabled globally.');
  return decide(false, 'none', 'Not enabled for this project, provider, role or session.');
}

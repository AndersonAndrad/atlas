// Side effects are recognized from what a command or step does, never from its name
// (FR-710). The lists are deliberately broad: a false alarm costs one confirmation, a
// missed deployment does not. They cannot be complete, which the UI says.

const COMMAND_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:\S+\s+)*publish\b/, 'publishes a package'],
  [/\b(?:cargo|gem|poetry|dotnet\s+nuget)\s+(?:publish|push)\b/, 'publishes a package'],
  [/\btwine\s+upload\b/, 'publishes a package'],
  [/\bdocker\s+(?:image\s+)?push\b|\bbuildx\s+build\b[^\n]*--push\b/, 'pushes a container image'],
  [/\bgh\s+release\b/, 'creates a release'],
  [/\bgit\s+push\b/, 'pushes to a Git remote'],
  [/\bterraform\s+(?:apply|destroy|import)\b/, 'changes infrastructure (Terraform)'],
  [/\bpulumi\s+(?:up|destroy)\b/, 'changes infrastructure (Pulumi)'],
  [/\bcdk\s+(?:deploy|destroy)\b/, 'changes infrastructure (CDK)'],
  [
    /\bkubectl\s+(?:apply|create|delete|replace|patch|rollout|scale|set)\b/,
    'changes a Kubernetes cluster',
  ],
  [/\bhelm\s+(?:install|upgrade|uninstall|rollback)\b/, 'changes a Kubernetes cluster'],
  [/(?:^|[\s;&|(])(?:aws|gcloud|az|doctl|oci)\s+[a-z]/, 'calls a cloud provider CLI'],
  [
    /\b(?:firebase|vercel|netlify|wrangler|serverless|sls)\s+(?:\S+\s+)*deploy\b|\b(?:fly|flyctl)\s+deploy\b|\bheroku\s+(?:\S+\s+)*(?:releases|deploy|push)\b/,
    'deploys an application',
  ],
  [
    /\bprisma\s+migrate\s+deploy\b|\bknex\s+migrate:(?:latest|up)\b|\bdb:migrate\b|\balembic\s+upgrade\b|\bflyway\s+migrate\b|\bliquibase\s+update\b|\bsequelize\s+db:migrate\b/,
    'migrates a database',
  ],
  [
    /\b(?:curl|wget)\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|-d\s|--upload-file|-T\s|--post-data)/,
    'sends data over the network',
  ],
  [/\b(?:ssh|scp|rsync)\s+\S*@/, 'connects to a remote host'],
];

const ACTION_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^aws-actions\//i, 'uses cloud credentials (AWS)'],
  [/^google-github-actions\//i, 'uses cloud credentials (Google Cloud)'],
  [/^azure\//i, 'uses cloud credentials (Azure)'],
  [
    /^(?:softprops\/action-gh-release|ncipollo\/release-action|actions\/create-release)\b/i,
    'creates a release',
  ],
  [/^(?:pypa\/gh-action-pypi-publish|js-devtools\/npm-publish)\b/i, 'publishes a package'],
  [/^peaceiris\/actions-gh-pages\b/i, 'publishes a website'],
  [/^(?:slackapi\/|8398a7\/action-slack|rtCamp\/action-slack)/i, 'sends a notification'],
  [/^appleboy\/(?:ssh|scp)-action\b/i, 'connects to a remote host'],
  [/(?:^|\/)[^@]*deploy[^@]*(?:@|$)/i, 'looks like a deployment action'],
];

/** Reasons a shell command may change something outside this computer. */
export function commandDangers(command: string): string[] {
  const reasons = new Set<string>();
  for (const [pattern, reason] of COMMAND_PATTERNS) {
    if (pattern.test(command)) reasons.add(reason);
  }
  return [...reasons];
}

/** Reasons an action reference (`owner/repo@ref`) may change something outside. */
export function actionDangers(action: string): string[] {
  const reasons = new Set<string>();
  for (const [pattern, reason] of ACTION_PATTERNS) {
    if (pattern.test(action)) reasons.add(reason);
  }
  return [...reasons];
}

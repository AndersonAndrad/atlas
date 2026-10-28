import type { HostingProvider } from '@atlas/contracts';
import { HostingApiError, type HostingApi, type HostingCredential } from '@atlas/hosting';
import type { Logger } from '@atlas/shared';
import { z } from 'zod';

export const GITHUB_API_URL = 'https://api.github.com';
export const BITBUCKET_API_URL = 'https://api.bitbucket.org/2.0';

const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

const GitHubUserSchema = z.object({
  login: z.string().min(1).max(255),
  name: z.string().max(255).nullish(),
});
const BitbucketUserSchema = z.object({
  username: z.string().max(255).nullish(),
  nickname: z.string().max(255).nullish(),
  display_name: z.string().max(255).nullish(),
});

const MESSAGES = {
  GITHUB: {
    invalid: 'GitHub rejected the token. Create a new token and save it again.',
    denied: 'The token cannot read your GitHub user. Check its permissions.',
  },
  BITBUCKET: {
    invalid:
      'Bitbucket rejected the email and token. Use an API token with scopes and the email of your Atlassian account; app passwords no longer work.',
    denied: 'The token lacks a scope. It needs read:user, read:repository and read:pullrequest.',
  },
} as const;

interface Response {
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * Read-only GitHub and Bitbucket Cloud REST calls (SDD-024 Task 04, FR-003, FR-022). Every
 * request has a timeout and a size limit, redirects are followed only on the same origin
 * so the Authorization header never leaves the provider, and answers are validated.
 * Tokens are never logged or put in URLs.
 */
export class HttpHostingApi implements HostingApi {
  private readonly bases: Record<HostingProvider, URL>;

  constructor(
    private readonly options: {
      userAgent: string;
      logger: Logger;
      baseUrls?: Partial<Record<HostingProvider, string>>;
    },
  ) {
    this.bases = {
      GITHUB: new URL(`${options.baseUrls?.GITHUB ?? GITHUB_API_URL}/`),
      BITBUCKET: new URL(`${options.baseUrls?.BITBUCKET ?? BITBUCKET_API_URL}/`),
    };
  }

  async verify(provider: HostingProvider, credential: HostingCredential) {
    const response = await this.get(provider, credential, 'user');
    this.raise(provider, response);
    if (provider === 'GITHUB') {
      const user = GitHubUserSchema.safeParse(response.body);
      if (!user.success) throw this.invalidAnswer();
      return { login: user.data.login, displayName: user.data.name ?? null };
    }
    const user = BitbucketUserSchema.safeParse(response.body);
    const login = user.success ? (user.data.username ?? user.data.nickname) : null;
    if (!user.success || !login) throw this.invalidAnswer();
    return { login, displayName: user.data.display_name ?? null };
  }

  async repositoryAccess(
    provider: HostingProvider,
    credential: HostingCredential,
    owner: string,
    name: string,
  ): Promise<'ACCESSIBLE' | 'NOT_FOUND'> {
    const path = `${provider === 'GITHUB' ? 'repos' : 'repositories'}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const response = await this.get(provider, credential, path);
    // Providers answer 404 (or 403 for a token without that repository) instead of telling
    // whether a private repository exists.
    if (response.status === 404) return 'NOT_FOUND';
    if (response.status === 403 && !this.rateLimited(response)) return 'NOT_FOUND';
    this.raise(provider, response);
    return 'ACCESSIBLE';
  }

  private raise(provider: HostingProvider, response: Response): void {
    const { status } = response;
    if (status >= 200 && status < 300) return;
    if (status === 401)
      throw new HostingApiError('INVALID_CREDENTIALS', MESSAGES[provider].invalid);
    if (this.rateLimited(response)) {
      throw new HostingApiError(
        'RATE_LIMITED',
        'The provider is limiting requests. Try again in a few minutes.',
      );
    }
    if (status === 403) throw new HostingApiError('PERMISSION_DENIED', MESSAGES[provider].denied);
    if (status >= 500) {
      throw new HostingApiError('UNREACHABLE', 'The provider is unavailable. Try again later.');
    }
    throw new HostingApiError('ERROR', `The provider answered with status ${status}.`);
  }

  private rateLimited(response: Response): boolean {
    return (
      response.status === 429 ||
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    );
  }

  private invalidAnswer(): HostingApiError {
    return new HostingApiError('ERROR', 'The provider sent an answer ATLAS did not understand.');
  }

  private headers(provider: HostingProvider, credential: HostingCredential): Headers {
    const headers = new Headers({ 'User-Agent': this.options.userAgent });
    if (provider === 'GITHUB') {
      headers.set('Accept', 'application/vnd.github+json');
      headers.set('X-GitHub-Api-Version', '2022-11-28');
      headers.set('Authorization', `Bearer ${credential.token}`);
    } else {
      headers.set('Accept', 'application/json');
      const basic = Buffer.from(`${credential.email ?? ''}:${credential.token}`).toString('base64');
      headers.set('Authorization', `Basic ${basic}`);
    }
    return headers;
  }

  private async get(
    provider: HostingProvider,
    credential: HostingCredential,
    path: string,
  ): Promise<Response> {
    const base = this.bases[provider];
    let url = new URL(path, base);
    for (let redirects = 0; ; redirects++) {
      let response: globalThis.Response;
      try {
        response = await fetch(url, {
          headers: this.headers(provider, credential),
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        this.options.logger.info('Hosting provider request failed', {
          provider,
          timedOut,
          reason: error instanceof Error ? error.name : 'unknown',
        });
        throw new HostingApiError(
          'UNREACHABLE',
          timedOut
            ? 'The provider did not answer in time.'
            : 'The provider could not be reached. Check the connection.',
        );
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel();
        const next = new URL(location, url);
        // A renamed repository redirects within the API; anything else is not followed.
        if (next.origin !== base.origin || redirects >= MAX_REDIRECTS) {
          throw new HostingApiError('ERROR', 'The provider redirected the request elsewhere.');
        }
        url = next;
        continue;
      }
      return {
        status: response.status,
        headers: response.headers,
        body: await this.json(response),
      };
    }
  }

  private async json(response: globalThis.Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (reader === undefined) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new HostingApiError('ERROR', 'The provider sent an answer that is too large.');
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      return null;
    }
  }
}

/**
 * Provider API addresses for the tests: only loopback http(s) URLs are accepted, so a
 * token can never be sent to another host by changing the environment.
 */
export function hostingApiOverrides(
  env: Record<string, string | undefined>,
  logger: Logger,
): Partial<Record<HostingProvider, string>> {
  const result: Partial<Record<HostingProvider, string>> = {};
  const entries: [HostingProvider, string][] = [
    ['GITHUB', 'ATLAS_GITHUB_API_URL'],
    ['BITBUCKET', 'ATLAS_BITBUCKET_API_URL'],
  ];
  for (const [provider, name] of entries) {
    const value = env[name];
    if (!value) continue;
    try {
      const url = new URL(value);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new Error();
      result[provider] = value.replace(/\/+$/, '');
      logger.warn(`Hosting API calls use ${name}`);
    } catch {
      logger.warn(`Ignoring ${name}: only loopback addresses are accepted`);
    }
  }
  return result;
}

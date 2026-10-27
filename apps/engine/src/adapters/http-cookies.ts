import type { HttpCookieJars } from '@atlas/api-workbench';
import type { HttpCookie } from '@atlas/contracts';
import { Cookie, CookieJar } from 'tough-cookie';

function toHttpCookie(cookie: Cookie, url: string | null): HttpCookie {
  const expiry = cookie.expiryDate();
  return {
    name: cookie.key,
    value: cookie.value,
    domain: cookie.domain ?? (url === null ? '' : new URL(url).hostname),
    path: cookie.path ?? '/',
    expires: expiry && Number.isFinite(expiry.getTime()) ? expiry.toISOString() : null,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite ?? null,
  };
}

/**
 * One cookie jar per collection, in memory only (FR-1413): cookies are scoped by domain,
 * path, Secure and expiry, public suffixes are refused, and nothing reaches the disk.
 */
export class MemoryCookieJars implements HttpCookieJars {
  private readonly jars = new Map<string, CookieJar>();

  private jar(id: string): CookieJar {
    let jar = this.jars.get(id);
    if (jar === undefined) {
      jar = new CookieJar(undefined, { rejectPublicSuffixes: true, looseMode: true });
      this.jars.set(id, jar);
    }
    return jar;
  }

  async cookieHeader(jarId: string, url: string): Promise<string | null> {
    const jar = this.jars.get(jarId);
    if (jar === undefined) return null;
    const header = await jar.getCookieString(url);
    return header === '' ? null : header;
  }

  async store(jarId: string, url: string, setCookies: readonly string[]): Promise<void> {
    const jar = this.jar(jarId);
    for (const value of setCookies) {
      // Cookies the URL may not set (another domain, a public suffix) are dropped.
      await jar.setCookie(value, url, { ignoreError: true });
    }
  }

  async list(jarId: string): Promise<HttpCookie[]> {
    const jar = this.jars.get(jarId);
    if (jar === undefined) return [];
    const { cookies } = await jar.serialize();
    return cookies
      .map((serialized) => Cookie.fromJSON(serialized))
      .filter((cookie): cookie is Cookie => cookie !== undefined)
      .map((cookie) => toHttpCookie(cookie, null));
  }

  async clear(jarId: string): Promise<void> {
    this.jars.delete(jarId);
  }

  parse(setCookie: string, url: string): HttpCookie | null {
    const cookie = Cookie.parse(setCookie, { loose: true });
    return cookie === undefined ? null : toHttpCookie(cookie, url);
  }
}

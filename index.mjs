/**
 * dsh-cookie-fix — Host-only DSH plugin.
 *
 * Problem: the desktop host starts its local Web server on a random loopback
 * port at every launch and mints one `dsh-auth-<sha256(host:port)>` cookie per
 * launch with a 30-day Max-Age. Cookies are host-scoped, not port-scoped, so
 * every launch adds another cookie to the same Chromium cookie jar. The
 * desktop's own welcome handshake performs
 * `net.fetch(authenticatedUrl, { credentials: "include" })`, which sends that
 * whole jar. After roughly 70 launches the Cookie request header exceeds
 * Node's 16 KiB request-header limit, the Host answers HTTP 431, and the
 * desktop reports `desktop welcome: Web authentication failed` and cannot
 * start.
 *
 * Fix: prepend one request listener to the DSH webserver. On `GET /` — the
 * launch-token exchange the desktop performs on every start — the listener
 * appends `Set-Cookie: dsh-auth-…=; Max-Age=0` deletions to the response for
 * every session cookie except the current authority's cookie and the two
 * newest stale ones. The requesting client (Electron's session fetch or a
 * browser) applies those deletions, so at most three `dsh-auth-*` cookies
 * remain after a launch, including the one the same response mints.
 *
 * Nothing else in the app is changed: no `app.asar` edit, no port pinning, no
 * client bundle, no network access, no storage. Removing the bundle removes the
 * listener with the plugin fiber and restores the stock behaviour.
 */

import { createHash } from 'node:crypto';

/** Stable Cordis plugin name. */
export const name = 'dsh-cookie-fix';
/** The plugin only has work when the Web carrier exists. */
export const inject = ['webServer'];

const COOKIE_PREFIX = 'dsh-auth-';
/** Keep the current authority's cookie plus this many newest stale cookies. */
const KEEP_STALE = 2;

/** Canonical cookie name: `dsh-auth-` + base64url(sha256(authority)). */
function cookieNameForAuthority(authority) {
  return COOKIE_PREFIX + createHash('sha256').update(authority).digest('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Read only the generated cookie prefix from a Cookie request header. */
function parseSessionCookies(header) {
  const cookies = [];
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    const name = segment.slice(0, at).trim();
    if (!name.startsWith(COOKIE_PREFIX)) continue;
    cookies.push({ name, value: segment.slice(at + 1).trim() });
  }
  return cookies;
}

/**
 * Decode `v1.<base64url JSON>.<signature>` just enough to read `issuedAt`.
 * No signature verification is needed: this only ranks already-sent cookies.
 */
function issuedAt(value) {
  const parts = value.split('.');
  if (parts.length !== 3 || (parts[0] !== 'v1' && parts[0] !== 'v2')) return undefined;
  try {
    const encoded = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    return Number.isSafeInteger(payload.issuedAt) ? payload.issuedAt : undefined;
  } catch {
    return undefined;
  }
}

/** A deletion Set-Cookie value for one host-only, Path=/ session cookie. */
function deletionCookie(name, secure) {
  return name + '=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    + (secure ? '; Secure' : '');
}

/**
 * Plan deletions for one request. Keep the request authority's own cookie (the
 * response mints a fresh one for it) plus the newest KEEP_STALE *other*
 * cookies, so a launch leaves at most three session cookies.
 * @param {string} header Raw Cookie request header.
 * @param {string} authority Host header (host[:port]).
 * @param {boolean} secure Whether the listener serves TLS.
 * @returns {string[]} deletion Set-Cookie values; empty when nothing is stale.
 */
function planDeletions(header, authority, secure) {
  const cookies = parseSessionCookies(header);
  if (cookies.length === 0) return [];
  const current = cookieNameForAuthority(authority);
  const ranked = cookies
    .map((cookie) => ({ ...cookie, at: issuedAt(cookie.value) ?? -1 }))
    .sort((left, right) => right.at - left.at);
  const stale = ranked.filter((cookie) => cookie.name !== current);
  const keep = new Set(stale.slice(0, KEEP_STALE).map((cookie) => cookie.name));
  keep.add(current);
  return cookies
    .filter((cookie) => !keep.has(cookie.name))
    .map((cookie) => deletionCookie(cookie.name, secure));
}

/**
 * Wrap one response's writeHead so deletion headers are emitted together with
 * whatever the route already set. Existing Set-Cookie values stay first: the
 * desktop's `authenticateWebHost()` reads `response.headers.get('set-cookie')`
 * and takes the text before the first semicolon, so the freshly minted auth
 * cookie must remain the first value.
 */
function attachDeletions(res, deletions) {
  const original = res.writeHead;
  let patched = false;
  res.writeHead = function writeHeadWithCookieFix(statusCode, statusMessage, headers) {
    if (patched) return original.apply(this, arguments);
    patched = true;
    let message;
    let extra;
    if (typeof statusMessage === 'string') {
      message = statusMessage;
      extra = headers;
    } else {
      message = undefined;
      extra = statusMessage;
    }
    if (extra !== null && typeof extra === 'object') {
      const copy = { ...extra };
      const key = Object.keys(copy).find((candidate) => candidate.toLowerCase() === 'set-cookie');
      const supplied = key === undefined
        ? []
        : (Array.isArray(copy[key]) ? copy[key].slice() : [copy[key]]);
      if (key !== undefined) delete copy[key];
      const preset = res.getHeader('set-cookie');
      const presetList = preset === undefined ? [] : (Array.isArray(preset) ? preset : [preset]);
      copy['set-cookie'] = [...presetList, ...supplied, ...deletions];
      return message === undefined
        ? original.call(this, statusCode, copy)
        : original.call(this, statusCode, message, copy);
    }
    const preset = res.getHeader('set-cookie');
    const presetList = preset === undefined ? [] : (Array.isArray(preset) ? preset : [preset]);
    res.setHeader('set-cookie', [...presetList, ...deletions]);
    return message === undefined
      ? original.call(this, statusCode)
      : original.call(this, statusCode, message);
  };
}

/** Install the request hook on the live webserver; returns its disposer. */
function install(webServer) {
  const server = webServer?.server;
  if (server === undefined || server === null || typeof server.prependListener !== 'function') {
    return () => {};
  }
  const secure = webServer.protocol === 'https:';
  const onRequest = (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return;
      const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname;
      if (pathname !== '/') return;
      const header = req.headers.cookie;
      const authority = req.headers.host;
      if (typeof header !== 'string' || header.length === 0) return;
      if (typeof authority !== 'string' || authority.length === 0) return;
      const deletions = planDeletions(header, authority, secure);
      if (deletions.length > 0) attachDeletions(res, deletions);
    } catch {
      // A cookie-cleanup failure must never break a request. The app keeps
      // working and the next launch tries again.
    }
  };
  server.prependListener('request', onRequest);
  return () => {
    server.removeListener('request', onRequest);
  };
}

/** Cordis entry: runs once the Web carrier service is available. */
export function apply(ctx) {
  try {
    ctx.effect(() => install(ctx.webServer), 'dsh-cookie-fix: request listener');
  } catch (error) {
    try {
      ctx.logger?.warn?.('dsh-cookie-fix: failed to attach request listener');
      ctx.logger?.warn?.(error);
    } catch {
      /* logging must not break activation */
    }
  }
}

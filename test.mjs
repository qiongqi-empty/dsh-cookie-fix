/*
 * dsh-cookie-fix self-test. Does not start DSH: it runs a real node:http
 * server that mimics the launch-token exchange (303 + signed cookie) and
 * checks the plugin's request hook.
 *
 *   node test.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { apply } from './index.mjs';

function b64url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function cookieName(authority) {
  return 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
}

function makeCookie(authority, issuedAtValue) {
  const payload = b64url(JSON.stringify({
    version: 1,
    authority,
    issuedAt: issuedAtValue,
    expiresAt: issuedAtValue + 30 * 86400000
  }));
  return `${cookieName(authority)}=v1.${payload}.${b64url('signature')}`;
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, cookie, path = '/') {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path,
      headers: { host: `127.0.0.1:${port}`, cookie }
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const handler = (req, res) => {
    // Simulate connection.authorizeIndex minting the new cookie on the token exchange.
    res.writeHead(303, {
      'cache-control': 'no-store',
      location: './',
      'set-cookie': 'dsh-auth-NEW=; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
    });
    res.end();
  };
  const server = await startServer(handler);
  const { port } = server.address();
  const authority = `127.0.0.1:${port}`;

  apply({
    webServer: { server, protocol: 'http:' },
    effect(fn) { return fn(); }
  });

  try {
    // Ten cookies: keep the newest two stale plus the current authority's one.
    const current = makeCookie(authority, 2000);
    const stale = [];
    for (let index = 0; index < 9; index += 1) stale.push(makeCookie(`127.0.0.1:${30000 + index}`, 1000 + index));
    const all = [current, ...stale].join('; ');

    const response = await request(server, all);
    assert.equal(response.status, 303);
    const setCookie = response.setCookie;
    assert.ok(setCookie.length >= 1, 'should emit Set-Cookie headers');
    assert.ok(String(setCookie[0]).startsWith('dsh-auth-NEW='), 'minted auth cookie must be first');
    const deletions = setCookie.filter((value) => value.includes('Max-Age=0'));
    assert.equal(deletions.length, 7, `expected 7 deletions, got ${deletions.length}`);
    for (const value of deletions) {
      assert.ok(value.includes('Path=/'), 'deletion keeps Path=/');
      assert.ok(value.includes('HttpOnly'), 'deletion keeps HttpOnly');
    }

    // Few cookies: no deletions appended.
    const small = [makeCookie(authority, 2000), makeCookie('127.0.0.1:1', 1000)].join('; ');
    const quiet = await request(server, small);
    assert.equal(quiet.setCookie.filter((value) => value.includes('Max-Age=0')).length, 0, 'no deletions when the jar is small');

    // Other paths are untouched.
    const other = await request(server, all, '/api/ping');
    assert.equal(other.setCookie.filter((value) => value.includes('Max-Age=0')).length, 0, 'other paths untouched');
  } finally {
    server.close();
  }

  console.log('dsh-cookie-fix self-test: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

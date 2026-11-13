import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { requestHandler } from './server.mjs';

function request(url: string, method = 'GET') {
  const headers: Record<string, string> = {};
  const res = { status: 0, body: '', setHeader(k: string, v: string) { headers[k] = v; }, writeHead(n: number) { this.status = n; }, end(body = '') { this.body = body; } };
  requestHandler({ url, method }, res);
  return { ...res, headers, json: JSON.parse(res.body) };
}

describe('standalone read-only PDA preview', () => {
  it('derives the same keyless PDA without custody or provider calls', () => {
    const first = request('/api/vault-info?owner=11111111111111111111111111111111');
    expect(first.status).toBe(200);
    expect(request('/api/vault-info?owner=11111111111111111111111111111111').json).toEqual(first.json);
    expect(first.json.pda.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(first.json.interactiveVault).toBeNull();
    expect(first.json.actionsEnabled).toBe(false);
    expect(first.json.pda.balanceLamports).toBeNull();
  });
  it.each(['authorized-withdraw', 'unauthorized-withdraw', 'fund', 'challenge'])('refuses %s even with a configured secret and opt-in', (action) => {
    vi.stubEnv('TESTBED_VAULT_SECRET', 'fixture-only-not-a-key');
    vi.stubEnv('TESTBED_DEVNET_ACTIONS', 'true');
    const response = request(`/api/action/${action}`, 'POST');
    expect(response.status).toBe(501);
    expect(response.json.success).toBe(false);
    vi.unstubAllEnvs();
  });
  it('returns generic invalid input and baseline security headers', () => {
    const response = request('/api/vault-info?owner=%3Csvg%20onload=alert(1)%3E');
    expect(response.status).toBe(400);
    expect(response.json.error).toBe('Invalid owner public key');
    expect(response.headers['Content-Security-Policy']).toContain("script-src 'self'");
    expect(response.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(response.headers['Cache-Control']).toBe('no-store');
  });
  it('renders hostile preview text without HTML or browser signing', () => {
    const elements = new Map<string, any>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { value: 'owner', textContent: '', addEventListener: vi.fn(), set innerHTML(_: string) { throw new Error('unsafe HTML'); } });
      return elements.get(id);
    };
    const sandbox = { document: { getElementById: element }, URL, window: {}, fetch: vi.fn() };
    vm.runInNewContext(readFileSync(new URL('./public/preview.js', import.meta.url), 'utf8'), sandbox);
    (sandbox.window as any).renderPreview({ pda: { address: '<img src=x onerror=alert(1)>', bump: 255 } });
    expect(element('result').textContent).toContain('<img src=x onerror=alert(1)>');
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });
});

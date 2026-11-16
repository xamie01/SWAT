import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { loadPackage28LimiterConfig, package28TrustProxy, registerPackage28Limiters } from './package28-limiter.js';

async function server(env: Record<string, string> = {}) {
  const config = loadPackage28LimiterConfig({ RATE_LIMIT_MAX: '100', AUTH_RATE_LIMIT_MAX: '2', AUTH_ACCOUNT_RATE_LIMIT_MAX: '2', ...env });
  const app = Fastify({ trustProxy: package28TrustProxy(config) });
  await registerPackage28Limiters(app, config);
  app.post('/v1/auth/login', async request => ({ email: (request.body as { email: string })?.email }));
  app.post('/v1/auth/signup', async () => ({ ok: true }));
  app.get('/v1/auth/me', async () => ({ ok: true }));
  app.post('/v1/auth/wallet/nonce', async () => ({ ok: true }));
  return app;
}

describe('package28 limiter', () => {
  it('wires validated config and one limiter registration before construction/auth without executing the entrypoint', () => {
    const source = ts.createSourceFile('index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const calls: ts.CallExpression[] = [];
    const constructions: ts.NewExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) calls.push(node);
      if (ts.isNewExpression(node)) constructions.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const named = (name: string) => calls.filter(call => ts.isIdentifier(call.expression) && call.expression.text === name);
    const imports = source.statements.filter(ts.isImportDeclaration);
    expect(imports[0]?.moduleSpecifier.getText(source)).toBe("'./package28-limiter.js'");
    const imported = imports[0]?.importClause?.namedBindings;
    expect(imported && ts.isNamedImports(imported) ? imported.elements.map(element => element.name.text).sort() : []).toEqual([
      'loadPackage28LimiterConfig', 'package28TrustProxy', 'registerPackage28Limiters'
    ]);
    expect(imports.some(declaration => declaration.moduleSpecifier.getText(source) === "'@fastify/rate-limit'")).toBe(false);
    expect(named('loadPackage28LimiterConfig')).toHaveLength(1);
    const configCall = named('loadPackage28LimiterConfig')[0]!;
    expect(configCall.arguments.map(argument => argument.getText(source))).toEqual(['process.env']);
    expect(ts.isVariableDeclaration(configCall.parent)).toBe(true);
    const declaration = configCall.parent as ts.VariableDeclaration;
    expect(declaration.name.getText(source)).toBe('limiterConfig');
    expect(ts.isVariableDeclarationList(declaration.parent) && ts.isVariableStatement(declaration.parent.parent)).toBe(true);
    expect(named('Fastify')).toHaveLength(1);
    const constructor = named('Fastify')[0]!;
    expect(configCall.getStart(source)).toBeLessThan(constructor.getStart(source));
    const options = constructor.arguments[0]!;
    expect(ts.isObjectLiteralExpression(options)).toBe(true);
    const trustProxy = (options as ts.ObjectLiteralExpression).properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'trustProxy') as ts.PropertyAssignment | undefined;
    expect(trustProxy?.initializer.getText(source)).toBe('package28TrustProxy(limiterConfig)');
    expect(named('registerPackage28Limiters')).toHaveLength(1);
    const registration = named('registerPackage28Limiters')[0]!;
    expect(registration.arguments.map(argument => argument.getText(source))).toEqual(['app', 'limiterConfig']);
    expect(ts.isAwaitExpression(registration.parent) && ts.isExpressionStatement(registration.parent.parent) && ts.isSourceFile(registration.parent.parent.parent)).toBe(true);
    expect(named('registerAuth')).toHaveLength(1);
    expect(registration.getStart(source)).toBeLessThan(named('registerAuth')[0]!.getStart(source));
    for (const effect of [...constructions, ...calls.filter(call => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'listen')]) {
      expect(configCall.getStart(source)).toBeLessThan(effect.getStart(source));
    }
    expect(calls.filter(call => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'register' && call.arguments[0]?.getText(source) === 'rateLimit')).toHaveLength(0);
    const authRoutes = named('registerAuthRoutes');
    expect(authRoutes).toHaveLength(1);
    expect(authRoutes[0]!.arguments[0]!.getText(source)).toBe('scope');
    expect(registration.getStart(source)).toBeLessThan(authRoutes[0]!.getStart(source));
  });
  it('validates environment in the first-imported limiter before eager database dependencies can evaluate', () => {
    const source = ts.createSourceFile('package28-limiter.ts', readFileSync(new URL('./package28-limiter.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const preflight = source.statements.filter(ts.isExpressionStatement).filter(statement =>
      ts.isCallExpression(statement.expression) && statement.expression.expression.getText(source) === 'loadPackage28LimiterConfig');
    expect(preflight).toHaveLength(1);
    expect((preflight[0]!.expression as ts.CallExpression).arguments.map(argument => argument.getText(source))).toEqual(['process.env']);
    expect(source.statements.filter(ts.isImportDeclaration).map(declaration => declaration.moduleSpecifier.getText(source))).toEqual([
      "'@fastify/rate-limit'", "'fastify'", "'node:net'"
    ]);
  });
  it.each(['RATE_LIMIT_MAX', 'AUTH_RATE_LIMIT_MAX', 'AUTH_ACCOUNT_RATE_LIMIT_MAX'])('refuses malformed/beyond-bound %s before any Fastify construction', name => {
    const malformed = ['', '0', '-1', 'NaN', 'Infinity', '1.5', '1e2', '0x10', ' 10 ', '01', '+1', '9007199254740992', name === 'RATE_LIMIT_MAX' ? '10001' : '1001'];
    let constructed = false;
    for (const raw of malformed) {
      expect(() => {
        const config = loadPackage28LimiterConfig({ [name]: raw });
        constructed = true;
        return Fastify({ trustProxy: package28TrustProxy(config) });
      }).toThrow(`${name} must be an integer between 1 and ${name === 'RATE_LIMIT_MAX' ? 10000 : 1000}`);
      expect(constructed).toBe(false);
    }
  });
  it.each([
    [{}, { max: 300, authIpMax: 10, authAccountMax: 10, trustedProxy: null }],
    [{ RATE_LIMIT_MAX: '1', AUTH_RATE_LIMIT_MAX: '1', AUTH_ACCOUNT_RATE_LIMIT_MAX: '1' }, { max: 1, authIpMax: 1, authAccountMax: 1, trustedProxy: null }],
    [{ RATE_LIMIT_MAX: '10000', AUTH_RATE_LIMIT_MAX: '1000', AUTH_ACCOUNT_RATE_LIMIT_MAX: '1000' }, { max: 10000, authIpMax: 1000, authAccountMax: 1000, trustedProxy: null }]
  ] as const)('loads immutable defaults and inclusive bounds for %j', (env, expected) => {
    const config = loadPackage28LimiterConfig(env);
    expect(config).toEqual(expected);
    expect(Object.isFrozen(config)).toBe(true);
  });
  it('rejects broad proxy authority and trusts only configured immediate peer', () => {
    for (const raw of ['', 'true', '*', '127.0.0.0/8', '0.0.0.0', '::', 'localhost', '127.0.0.1,192.0.2.1', ' 127.0.0.1 ']) {
      expect(() => loadPackage28LimiterConfig({ RATE_LIMIT_TRUSTED_PROXY: raw })).toThrow();
    }
    expect(package28TrustProxy(loadPackage28LimiterConfig({}))).toBe(false);
    const trusted = package28TrustProxy(loadPackage28LimiterConfig({ RATE_LIMIT_TRUSTED_PROXY: '127.0.0.1' }));
    if (trusted === false) throw new Error('missing trust predicate');
    expect(trusted('127.0.0.1', 0)).toBe(true);
    expect(trusted('127.0.0.1', 1)).toBe(false);
    expect(trusted('198.51.100.9', 0)).toBe(false);
    expect(trusted('127.0.0.1', -1)).toBe(false);
    const ipv6 = package28TrustProxy(loadPackage28LimiterConfig({ RATE_LIMIT_TRUSTED_PROXY: '2001:db8::1' }));
    if (ipv6 === false) throw new Error('missing IPv6 trust predicate');
    expect(ipv6('2001:db8::1', 0)).toBe(true);
    expect(ipv6('2001:db8::1', 1)).toBe(false);
    expect(ipv6('2001:db8::2', 0)).toBe(false);
  });
  it('uses parsed trimmed lower-case account across peers/query/routes', async () => {
    const app = await server();
    try {
      for (const [path, email, ip, expected] of [
        ['/v1/auth/login?x=1', ' User@Example.test ', '192.0.2.1', 200],
        ['/v1/auth/signup?x=2', 'user@example.test', '192.0.2.2', 200],
        ['/v1/auth/login?x=3', 'USER@example.test', '192.0.2.3', 429]
      ] as const) {
        expect((await app.inject({ method: 'POST', url: path, payload: { email }, remoteAddress: ip })).statusCode).toBe(expected);
      }
    } finally { await app.close(); }
  });
  it('early IP bucket cannot be evaded with account/header variations or malformed JSON', async () => {
    const app = await server();
    try {
      expect((await app.inject({ method: 'POST', url: '/v1/auth/login?a=1', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.1' }, payload: '{' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/v1/auth/signup?a=2', headers: { 'x-forwarded-for': '192.0.2.2' }, payload: { email: 'a@example.test' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/v1/auth/login?a=3', headers: { 'x-forwarded-for': '192.0.2.3' }, payload: { email: 'b@example.test' } })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
  it('trusted shared ingress separates clients but ignores forged leftmost forwarded chains', async () => {
    const app = await server({ RATE_LIMIT_TRUSTED_PROXY: '127.0.0.1' });
    try {
      const send = (forwarded: string, email: string) => app.inject({ method: 'POST', url: '/v1/auth/login', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': forwarded }, payload: { email } });
      expect((await send('192.0.2.1', 'a@example.test')).statusCode).toBe(200);
      expect((await send('192.0.2.2', 'b@example.test')).statusCode).toBe(200);
      expect((await send('198.51.100.1, 192.0.2.1', 'c@example.test')).statusCode).toBe(200);
      expect((await send('198.51.100.2, 192.0.2.1', 'd@example.test')).statusCode).toBe(429);
    } finally { await app.close(); }
  });
  it('rejects credential floods before a later auth hook in an inert child route scope', async () => {
    const config = loadPackage28LimiterConfig({ RATE_LIMIT_MAX: '100', AUTH_RATE_LIMIT_MAX: '1', AUTH_ACCOUNT_RATE_LIMIT_MAX: '10' });
    const app = Fastify({ trustProxy: package28TrustProxy(config) });
    let authCalls = 0;
    await registerPackage28Limiters(app, config);
    app.addHook('onRequest', async () => { authCalls++; });
    await app.register(async scope => {
      scope.post('/v1/auth/login', async () => ({ ok: true }));
      scope.post('/v1/auth/signup', async () => ({ ok: true }));
    });
    try {
      expect((await app.inject({ method: 'POST', url: '/v1/auth/login?first=1', payload: { email: 'first@example.test' } })).statusCode).toBe(200);
      const rejected = await app.inject({ method: 'POST', url: '/v1/auth/signup?second=1', payload: { email: 'second@example.test' } });
      expect(rejected.statusCode).toBe(429);
      expect(Number(rejected.headers['retry-after'])).toBeGreaterThan(0);
      expect(authCalls).toBe(1);
    } finally { await app.close(); }
  });
  it('ignores forwarded headers from an untrusted peer even with an exact trusted ingress configured', async () => {
    const app = await server({ RATE_LIMIT_TRUSTED_PROXY: '127.0.0.1', AUTH_RATE_LIMIT_MAX: '1' });
    try {
      const send = (forwarded: string, email: string) => app.inject({ method: 'POST', url: '/v1/auth/login', remoteAddress: '192.0.2.10', headers: { 'x-forwarded-for': forwarded }, payload: { email } });
      expect((await send('198.51.100.1', 'first@example.test')).statusCode).toBe(200);
      expect((await send('198.51.100.2', 'second@example.test')).statusCode).toBe(429);
    } finally { await app.close(); }
  });
  it('credential exclusions are path-based but global limiter still covers read/wallet routes', async () => {
    const app = await server({ RATE_LIMIT_MAX: '3', AUTH_RATE_LIMIT_MAX: '1' });
    try {
      expect((await app.inject('/v1/auth/me?q=1')).statusCode).toBe(200);
      expect((await app.inject('/v1/auth/me?q=2')).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/v1/auth/wallet/nonce?q=3', payload: {} })).statusCode).toBe(200);
      expect((await app.inject('/v1/auth/me?q=4')).statusCode).toBe(429);
    } finally { await app.close(); }
  });
});

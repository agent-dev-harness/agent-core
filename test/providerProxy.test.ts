import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';

const forwarded: Array<{ headers: Record<string, unknown>; body: string }> = [];

vi.mock('https', () => ({
  default: {
    request: (options: { headers: Record<string, unknown> }, onResponse: (res: unknown) => void) => {
      let body = '';
      const req = new EventEmitter() as EventEmitter & { write: (c: string) => void; end: () => void };
      req.write = (chunk: string) => {
        body += chunk;
      };
      req.end = () => {
        forwarded.push({ headers: options.headers, body });
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object; pipe: (d: NodeJS.WritableStream) => void };
        res.statusCode = 200;
        res.headers = { 'content-type': 'application/json' };
        res.pipe = (dest) => dest.end('{}');
        setTimeout(() => onResponse(res), 20);
      };
      return req;
    },
  },
}));

import express from 'express';
import { mountProviderProxyRoute } from '../src/proxy/providerProxy';
import { OPENROUTER_SESSION_ID_HEADER, ProviderRegistry } from '../src/providerRegistry';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  mountProviderProxyRoute(app, () => {});
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  server.close();
});

function post(sessionId: string | undefined, body: object): Promise<Response> {
  return fetch(`${baseUrl}/api/providers/openrouter/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sessionId ? { [OPENROUTER_SESSION_ID_HEADER]: sessionId } : {}) },
    body: JSON.stringify(body),
  });
}

describe('provider proxy OpenRouter session id', () => {
  it('stamps each request with its own session id, even when sessions overlap', async () => {
    forwarded.length = 0;
    await Promise.all([post('session-a', { model: 'x/a' }), post('session-b', { model: 'x/b' })]);

    const byModel = Object.fromEntries(forwarded.map((f) => [JSON.parse(f.body).model, JSON.parse(f.body).session_id]));
    expect(byModel).toEqual({ 'x/a': 'session-a', 'x/b': 'session-b' });
  });

  it('does not forward the session id header to the provider', async () => {
    forwarded.length = 0;
    await post('session-c', { model: 'x/c' });
    expect(forwarded[0]!.headers[OPENROUTER_SESSION_ID_HEADER]).toBeUndefined();
  });

  it('leaves the body alone without a header, and keeps a session_id the caller already set', async () => {
    forwarded.length = 0;
    await post(undefined, { model: 'x/d' });
    await post('session-e', { model: 'x/e', session_id: 'caller-set' });
    expect(JSON.parse(forwarded[0]!.body).session_id).toBeUndefined();
    expect(JSON.parse(forwarded[1]!.body).session_id).toBe('caller-set');
  });
});

describe('provider proxy routing', () => {
  it('refuses providers other than openrouter instead of forwarding them', async () => {
    forwarded.length = 0;
    const res = await fetch(`${baseUrl}/api/providers/gemini/v1beta/openai/chat/completions`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });
});

describe('ProviderRegistry openRouterSessionId', () => {
  it('puts the session id header on an OpenRouter provider config only', () => {
    const registry = new ProviderRegistry('key');
    const openrouter = registry.getExecutionConfig({ provider: 'openrouter', model: 'x/y' }, { openRouterSessionId: 's-1' });
    expect(openrouter.provider?.headers).toEqual({ [OPENROUTER_SESSION_ID_HEADER]: 's-1' });

    const native = registry.getExecutionConfig({ provider: 'copilot-native', model: 'gpt-5' }, { openRouterSessionId: 's-1' });
    expect(native.provider).toBeUndefined();
  });
});

describe('ProviderRegistry routing', () => {
  it('sends BYOK models through the OpenRouter proxy route, whatever VITEST says', () => {
    const saved = { url: process.env.COPILOT_API_URL, vitest: process.env.VITEST };
    process.env.COPILOT_API_URL = 'http://proxy.test';
    process.env.VITEST = 'true';
    try {
      const registry = new ProviderRegistry('key');
      expect(registry.getProviderConfig('openrouter', 'x/y')?.baseUrl).toBe('http://proxy.test/api/providers/openrouter/api/v1/');
      expect(registry.getProviderConfig('copilot-native', 'gpt-5')).toBeUndefined();
    } finally {
      for (const [key, value] of [['COPILOT_API_URL', saved.url], ['VITEST', saved.vitest]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('routes a model it has no config for to OpenRouter, with or without a vendor prefix', () => {
    const registry = new ProviderRegistry('key');
    expect(registry.getExecutionConfig('google/gemini-3.1-flash-lite')).toMatchObject({ providerType: 'openrouter', model: 'google/gemini-3.1-flash-lite' });
    expect(registry.getExecutionConfig('gpt-5')).toMatchObject({ providerType: 'openrouter', model: 'gpt-5' });
    expect(registry.getProviderType('gpt-5')).toBe('openrouter');
  });

  it('keeps a configured copilot-native model on the native path', () => {
    const registry = new ProviderRegistry('key', {
      tierModels: [],
      roleModels: [],
      allConfigs: [{ provider: 'copilot-native', model: 'gpt-5' }],
    });
    expect(registry.getExecutionConfig('gpt-5')).toMatchObject({ providerType: 'copilot-native', provider: undefined });
  });

  it('throws when no model is given and no tierModels are configured', () => {
    expect(() => new ProviderRegistry('key').getExecutionConfig('')).toThrow(/no model was given/);
    const withTiers = new ProviderRegistry('key', { tierModels: ['x/tier'], roleModels: [], allConfigs: [] });
    expect(withTiers.getMappedModel()).toBe('x/tier');
  });
});

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

describe('ProviderRegistry openRouterSessionId', () => {
  it('puts the session id header on an OpenRouter provider config only', () => {
    const registry = new ProviderRegistry('key');
    const openrouter = registry.getExecutionConfig({ provider: 'openrouter', model: 'x/y' }, { openRouterSessionId: 's-1' });
    expect(openrouter.provider?.headers).toEqual({ [OPENROUTER_SESSION_ID_HEADER]: 's-1' });

    const gemini = registry.getExecutionConfig({ provider: 'gemini', model: 'gemini-3.1-flash-lite' }, { openRouterSessionId: 's-1' });
    expect(gemini.provider?.headers).toBeUndefined();
  });
});

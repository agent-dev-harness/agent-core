import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import type { Server } from 'node:http';
import { PassThrough, Writable } from 'node:stream';

const upstream = { body: Buffer.alloc(0), failMidStream: false };

// Stands in for openrouter.ai: records the forwarded body, then streams a reply, optionally
// failing after the first chunk the way a reset connection does.
vi.mock('https', () => ({
  default: {
    request: (_options: unknown, onResponse: (res: unknown) => void) => {
      const chunks: Buffer[] = [];
      const req = new Writable({
        write(chunk: Buffer, _enc, cb) {
          chunks.push(chunk);
          cb();
        },
        final(cb) {
          upstream.body = Buffer.concat(chunks);
          const res = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/event-stream' } });
          setTimeout(() => {
            onResponse(res);
            res.write('data: {"partial":1}\n\n');
            if (upstream.failMidStream) setTimeout(() => req.emit('error', new Error('ECONNRESET')), 20);
            else res.end('data: [DONE]\n\n');
          }, 10);
          cb();
        },
      });
      return req;
    },
  },
}));

import express from 'express';
import { mountProviderProxyRoute } from '../src/proxy/providerProxy';

let server: Server;
let port: number;

beforeAll(async () => {
  const app = express();
  mountProviderProxyRoute(app, () => {});
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

// Writes the body in small pieces so multibyte characters straddle chunk boundaries.
function postInPieces(body: Buffer): Promise<{ status: number; text: string; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, path: '/api/providers/openrouter/api/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        let aborted = false;
        res.on('data', (d) => (text += d));
        res.on('aborted', () => (aborted = true));
        res.on('error', () => (aborted = true));
        res.on('close', () => resolve({ status: res.statusCode ?? 0, text, aborted: aborted || !res.complete }));
      },
    );
    req.on('error', reject);
    for (let i = 0; i < body.length; i += 1000) req.write(body.subarray(i, i + 1000));
    req.end();
  });
}

describe('provider proxy streaming', () => {
  it('forwards a multibyte body byte for byte, however it was chunked', async () => {
    upstream.failMidStream = false;
    const prompt = 'x'.repeat(999) + '日本語のテキスト🙂'.repeat(500);
    const body = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: prompt }] }));

    const res = await postInPieces(body);

    expect(res.status).toBe(200);
    expect(upstream.body.equals(body)).toBe(true);
  });

  it('cuts the client connection, and keeps the process up, when the upstream fails mid-stream', async () => {
    upstream.failMidStream = true;

    const res = await postInPieces(Buffer.from('{"model":"m"}'));

    expect(res.text).toContain('"partial":1');
    expect(res.aborted).toBe(true);
  });
});

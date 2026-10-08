import https from 'https';
import type { Express } from 'express';
import { OPENROUTER_SESSION_ID_HEADER } from '../providerRegistry';

const MAX_TRACKED_TOOL_LOG_KEYS = 1000;
const loggedToolListKeys = new Set<string>();

export function mountProviderProxyRoute(app: Express, writeLog: (msg: string) => void) {
  app.all('/api/providers/:provider/*', (req, res) => {
    // Joined as bytes, then decoded once: decoding each chunk would corrupt a multibyte
    // character split across two chunks.
    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('end', () => {
      const bodyData = Buffer.concat(bodyChunks).toString('utf8');
      const provider = req.params.provider;
      if (provider !== 'openrouter') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end(`Unknown provider '${provider}'. Only openrouter is proxied.`);
        return;
      }
      const method = req.method;
      const sessionHeader = req.headers[OPENROUTER_SESSION_ID_HEADER];
      const openRouterSessionId = typeof sessionHeader === 'string' && sessionHeader ? sessionHeader : undefined;

      let modifiedBody = bodyData;
      const targetHostname = 'openrouter.ai';
      try {
        if (bodyData && openRouterSessionId) {
          const data = JSON.parse(bodyData);
          if (data && typeof data === 'object' && !data.session_id) {
            data.session_id = openRouterSessionId;
            modifiedBody = JSON.stringify(data);
          }
        }
      } catch (e) {
        writeLog("Provider parse error (openrouter session_id): " + e);
      }

      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: targetHostname };
      delete headers[OPENROUTER_SESSION_ID_HEADER];
      if (!headers.authorization) {
        const key = process.env.OPENROUTER_API_KEY;
        if (key) {
          headers.authorization = `Bearer ${key}`;
        }
      }
      if (!headers['http-referer']) {
        headers['http-referer'] = 'https://github.com/github/copilot';
      }
      if (!headers['x-openrouter-title']) {
        headers['x-openrouter-title'] = 'GitHub Copilot';
      }
      delete headers['accept-encoding'];
      headers['content-length'] = Buffer.byteLength(modifiedBody).toString();

      const toolLogKey = `${provider}:${openRouterSessionId ?? ''}`;
      if (!loggedToolListKeys.has(toolLogKey)) {
        try {
          const parsedForLogging = modifiedBody ? JSON.parse(modifiedBody) : undefined;
          const toolNames = Array.isArray(parsedForLogging?.tools)
            ? parsedForLogging.tools.map((t: { name?: string; function?: { name?: string } }) => t.function?.name ?? t.name ?? '<unnamed>')
            : undefined;
          const line = toolNames
            ? `[ProviderProxy] ${provider} request tools (${toolNames.length}): ${toolNames.join(', ')}` +
              (openRouterSessionId ? ` [session_id=${openRouterSessionId}]` : '')
            : `[ProviderProxy] ${provider} request has no 'tools' field.`;
          writeLog(line);
          if (loggedToolListKeys.size >= MAX_TRACKED_TOOL_LOG_KEYS) loggedToolListKeys.clear();
          loggedToolListKeys.add(toolLogKey);
        } catch (e) {
          const errLine = `[ProviderProxy] tool-list logging: failed to parse/log tools: ${e instanceof Error ? e.message : String(e)}`;
          writeLog(errLine);
        }
      }

      const options = {
        hostname: targetHostname,
        port: 443,
        path: req.originalUrl.replace(`/api/providers/${provider}`, ''),
        method: method,
        headers
      };

      const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on('error', (err) => {
          writeLog("Provider proxy response error: " + err);
          res.destroy(err);
        });
      });

      // Once the response has started streaming, a status can no longer be sent: cut the
      // connection so the client sees the reply is incomplete.
      proxyReq.on('error', (err) => {
        writeLog("Provider proxy error: " + err);
        if (res.headersSent) {
          res.destroy(err);
          return;
        }
        res.writeHead(500);
        res.end('Provider proxy error: ' + err.message);
      });

      // A client that disconnects before the reply ends (the CLI does on wrapper.abort()) would
      // otherwise leave OpenRouter generating, and billing for, a reply nobody reads.
      res.on('close', () => {
        if (!res.writableFinished) proxyReq.destroy();
      });

      proxyReq.write(modifiedBody);
      proxyReq.end();
    });
  });
}

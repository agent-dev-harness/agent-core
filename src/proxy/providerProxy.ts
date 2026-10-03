import https from 'https';
import type { Express } from 'express';

let activeOpenRouterSessionId: string | undefined;
export function setActiveOpenRouterSessionId(sessionId: string | undefined) {
  activeOpenRouterSessionId = sessionId;
  hasLoggedProviderToolsForCurrentSession = false;
}

let hasLoggedProviderToolsForCurrentSession = false;

export function mountProviderProxyRoute(app: Express, writeLog: (msg: string) => void) {
  app.all('/api/providers/:provider/*', (req, res) => {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      const provider = req.params.provider;
      const method = req.method;

      let modifiedBody = bodyData;
      let targetHostname = 'api.openai.com';

      if (provider === 'gemini') {
        targetHostname = 'generativelanguage.googleapis.com';
        try {
          if (bodyData) {
            const data = JSON.parse(bodyData);
            if (data && Array.isArray(data.messages)) {
              data.messages.forEach((m: { refusal?: unknown; parsed?: unknown }) => {
                if ('refusal' in m) delete m.refusal;
                if ('parsed' in m) delete m.parsed;
              });
              modifiedBody = JSON.stringify(data);
            }
          }
        } catch (e) {
             writeLog("Provider parse error: " + e);
        }
      } else if (provider === 'anthropic') {
        targetHostname = 'api.anthropic.com';
      } else if (provider === 'openrouter') {
        targetHostname = 'openrouter.ai';
        try {
          if (bodyData && activeOpenRouterSessionId) {
            const data = JSON.parse(bodyData);
            if (data && typeof data === 'object' && !data.session_id) {
              data.session_id = activeOpenRouterSessionId;
              modifiedBody = JSON.stringify(data);
            }
          }
        } catch (e) {
          writeLog("Provider parse error (openrouter session_id): " + e);
        }
      }

      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: targetHostname };
      if (provider === 'openrouter') {
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
      }
      delete headers['accept-encoding'];
      headers['content-length'] = Buffer.byteLength(modifiedBody).toString();

      if (!hasLoggedProviderToolsForCurrentSession) {
        try {
          const parsedForLogging = modifiedBody ? JSON.parse(modifiedBody) : undefined;
          const toolNames = Array.isArray(parsedForLogging?.tools)
            ? parsedForLogging.tools.map((t: { name?: string; function?: { name?: string } }) => t.function?.name ?? t.name ?? '<unnamed>')
            : undefined;
          const line = toolNames
            ? `[ProviderProxy] ${provider} request tools (${toolNames.length}): ${toolNames.join(', ')}` +
              (activeOpenRouterSessionId ? ` [session_id=${activeOpenRouterSessionId}]` : '')
            : `[ProviderProxy] ${provider} request has no 'tools' field.`;
          console.log(line);
          writeLog(line);
          hasLoggedProviderToolsForCurrentSession = true;
        } catch (e) {
          const errLine = `[ProviderProxy] tool-list logging: failed to parse/log tools: ${e instanceof Error ? e.message : String(e)}`;
          console.log(errLine);
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
        if (provider === 'gemini' && proxyRes.statusCode && proxyRes.statusCode >= 400) {
          let errorBody: Buffer[] = [];
          proxyRes.on('data', d => errorBody.push(d));
          proxyRes.on('end', () => {
            let bodyStr = Buffer.concat(errorBody).toString();
            try {
              const parsed = JSON.parse(bodyStr);
              if (Array.isArray(parsed) && parsed.length === 1 && parsed[0].error) {
                bodyStr = JSON.stringify(parsed[0]);
              }
            } catch (e) {
            }
            res.writeHead(proxyRes.statusCode || 500, { ...proxyRes.headers, 'content-length': Buffer.byteLength(bodyStr).toString() });
            res.end(bodyStr);
          });
          return;
        }

        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        writeLog("Provider proxy error: " + err);
        res.writeHead(500);
        res.end('Provider proxy error: ' + err.message);
      });

      proxyReq.write(modifiedBody);
      proxyReq.end();
    });
  });
}

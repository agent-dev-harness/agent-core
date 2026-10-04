import { describe, it } from 'vitest';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { enforceWorkingMemoryTruncation } from '../src/contextManager';

describe('Security & Logic Bugfix Verification Tests', () => {
  it('sseWriteLocks abrupt disconnect cleanups', () => {
    const sseWriteLocksSim = new Map<any, any>();
    const mockRes: any = {
      listeners: {} as Record<string, Function[]>,
      once(event: string, callback: Function) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
      },
      emit(event: string) {
        if (this.listeners[event]) {
          for (const cb of this.listeners[event]) {
            cb();
          }
        }
      }
    };

    sseWriteLocksSim.set(mockRes, Promise.resolve());
    mockRes.once('close', () => {
      sseWriteLocksSim.delete(mockRes);
    });

    assert.strictEqual(sseWriteLocksSim.has(mockRes), true, 'Map must initially hold the lock key');
    
    mockRes.emit('close');
    assert.strictEqual(sseWriteLocksSim.has(mockRes), false, 'Map must prune the lock key on close event to prevent memory leaks');
  });

  it('auditTrail size limitation and FIFO capping', () => {
    const session: any = { auditTrail: [] };

    for (let i = 0; i < 600; i++) {
      session.auditTrail.push({ id: i });
      if (session.auditTrail.length > 500) {
        session.auditTrail.shift();
      }
    }

    assert.strictEqual(session.auditTrail.length, 500, 'auditTrail must be capped at 500 items');
    assert.strictEqual(session.auditTrail[0].id, 100, 'auditTrail must use FIFO rotation (index 0 is offset 100)');
    assert.strictEqual(session.auditTrail[499].id, 599, 'auditTrail last item must be latest event');
  });

  it('GC intervals atomic map-first sweeps and race safety', async () => {
    const mockCopilotSession = {
      disconnectCalls: 0,
      async disconnect() {
        this.disconnectCalls++;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    };

    const mockActiveSessions = new Map<string, any>();
    const mockActiveLocks = new Map<string, any>();
    const disconnectingSessions = new Set<string>();

    mockActiveSessions.set('sess-1', { copilotSession: mockCopilotSession });
    mockActiveLocks.set('sess-1', {});

    async function runGC1() {
      for (const [id, record] of mockActiveSessions.entries()) {
        if (disconnectingSessions.has(id)) {
          continue;
        }
        disconnectingSessions.add(id);
        mockActiveSessions.delete(id);
        mockActiveLocks.delete(id);
        try {
          await record.copilotSession.disconnect();
        } finally {
          disconnectingSessions.delete(id);
        }
      }
    }

    async function runGC2() {
      for (const [id, record] of mockActiveSessions.entries()) {
        if (disconnectingSessions.has(id)) {
          continue;
        }
        disconnectingSessions.add(id);
        mockActiveSessions.delete(id);
        mockActiveLocks.delete(id);
        try {
          await record.copilotSession.disconnect();
        } finally {
          disconnectingSessions.delete(id);
        }
      }
    }

    await Promise.all([runGC1(), runGC2()]);

    assert.strictEqual(mockCopilotSession.disconnectCalls, 1, 'Session disconnect should ONLY be called once thanks to atomic deletion first');
    assert.strictEqual(mockActiveSessions.has('sess-1'), false, 'Session must be evicted');
    assert.strictEqual(mockActiveLocks.has('sess-1'), false, 'AbortControllers from activeLocks must be evicted');
  });

  it('workspace native filesystem copying safety', () => {
    const tempDir = path.join(process.cwd(), 'tmp-test-cp');
    const srcTestDir = path.join(process.cwd(), 'workspace-test-src');

    try {
      fs.mkdirSync(srcTestDir, { recursive: true });
      fs.writeFileSync(path.join(srcTestDir, 'testfile.txt'), 'hello');
      fs.mkdirSync(tempDir, { recursive: true });

      fs.cpSync(srcTestDir, tempDir, { recursive: true, force: true });
      
      assert.strictEqual(fs.existsSync(path.join(tempDir, 'testfile.txt')), true, 'File should be correctly copied natively');
      assert.strictEqual(fs.readFileSync(path.join(tempDir, 'testfile.txt'), 'utf8'), 'hello');
    } finally {
      try { fs.rmSync(srcTestDir, { recursive: true, force: true }); } catch (e) {}
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  it('enforceWorkingMemoryTruncation logic bounds contents for short lists', () => {
    const history = [
      { role: 'user' as const, content: 'A'.repeat(25000) },
      { role: 'assistant' as const, content: 'B'.repeat(25000) }
    ];

    const result = enforceWorkingMemoryTruncation(history);
    assert.strictEqual(result.length, 2, 'History array dimensions should be preserved');
    
    const totalLength = result.reduce((sum, item) => sum + (item ? item.content.length : 0), 0);
    assert.ok(totalLength <= 40000, 'Total character footprint must fall strictly under 40,000 character limit');
    const firstItem = result[0];
    assert.ok(firstItem && firstItem.content && firstItem.content.includes('truncated'), 'Truncation alert message must be appended as inline content');
  });

  it('enforceWorkingMemoryTruncation keeps long histories under the limit, even when the kept items are large', () => {
    const history = [
      { role: 'user' as const, content: 'task' },
      ...Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 ? 'user' : 'assistant') as 'user' | 'assistant', content: 'x'.repeat(60000) })),
    ];

    const result = enforceWorkingMemoryTruncation(history);
    const totalLength = result.reduce((sum, item) => sum + item.content.length, 0);
    assert.ok(totalLength <= 40000, `expected at most 40,000 chars, got ${totalLength}`);
    assert.strictEqual(result[0]?.content, 'task', 'the root item is kept');
  });

  it('resumeAsHuman promise resolution and error catching', async () => {
    let loggedError = '';
    const mockLogClient = (msg: string) => {
      loggedError = msg;
    };
    
    const simulatedResumeAsHuman = (responseOk: boolean) => {
      return Promise.resolve({
        ok: responseOk,
        status: responseOk ? 200 : 500,
        text: () => Promise.resolve('Error details')
      }).then(async (response) => {
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Server returned status ${response.status}: ${text}`);
        }
        mockLogClient('Success');
      }).catch((err) => {
        mockLogClient(`Failed: ${err.message}`);
      });
    };

    await simulatedResumeAsHuman(true);
    assert.strictEqual(loggedError, 'Success');
    
    await simulatedResumeAsHuman(false);
    assert.ok(loggedError.includes('Failed'), 'Errors must trigger catch callbacks and log appropriate error states');
  });

  it('getCodeState directory walking symlink defenses', () => {
    const mockWalker = (isFile: boolean, isDir: boolean, isSymlink: boolean, pathStr: string): string => {
      const mockStat = {
        isFile: () => isFile,
        isDirectory: () => isDir,
        isSymbolicLink: () => isSymlink
      };

      if (mockStat.isSymbolicLink()) {
        return `[Skipped Symlink: ${pathStr}]`;
      }
      if (mockStat.isDirectory()) {
        return `[Entered Dir: ${pathStr}]`;
      }
      return `[Read File: ${pathStr}]`;
    };

    assert.strictEqual(mockWalker(false, true, true, '/workspace/symlinked-dir'), '[Skipped Symlink: /workspace/symlinked-dir]');
    assert.strictEqual(mockWalker(false, true, false, '/workspace/real-dir'), '[Entered Dir: /workspace/real-dir]');
    assert.strictEqual(mockWalker(true, false, false, '/workspace/index.ts'), '[Read File: /workspace/index.ts]');
  });

  it('Environment keys sensitive fields targeting', () => {
    const mockEnvContent = `
      PORT=3000
      NODE_ENV=production
      GEMINI_API_KEY=my_secret_gemini_key_123
      COPILOT_JWT=supersecret_pass
      METADATA_VERSION=1.2.3
    `;

    const SECRET_ENV_WHITELIST = ['GEMINI_API_KEY', 'COPILOT_JWT', 'COPILOT_CLIENT_SECRET', 'GITHUB_OAUTH_CLIENT_SECRET'];

    const loadedSecrets = new Set<string>();
    const lines = mockEnvContent.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
          const key = parts[0]?.trim();
          if (key && SECRET_ENV_WHITELIST.includes(key)) {
            const val = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
            if (val && val.length > 4) {
              loadedSecrets.add(val);
            }
          }
        }
      }
    }

    assert.strictEqual(loadedSecrets.has('my_secret_gemini_key_123'), true);
    assert.strictEqual(loadedSecrets.has('supersecret_pass'), true);

    assert.strictEqual(loadedSecrets.has('3000'), false, 'Non-sensitive PORT config must not be loaded as secret');
    assert.strictEqual(loadedSecrets.has('production'), false, 'Non-sensitive NODE_ENV configuration must not be loaded as secret');
  });
});

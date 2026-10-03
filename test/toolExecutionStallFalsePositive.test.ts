import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendAndWaitWithAbort, STALL_TIMEOUT_MS } from '../src/toolCallEnforcement';
import { SessionWrapper } from '../src/copilotSdk/sessionWrapper';

function makeWrapper(client: unknown, toolNames: string[] = ['my_tool']): SessionWrapper {
  return new SessionWrapper(client as any, { builtins: toolNames }, {})
    .setModelName('test-model')
    .setSystemPrompt('');
}

describe('tool-execution silence misdiagnosed as stall', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not false-positive stall when a non-target tool runs longer than STALL_TIMEOUT_MS', async () => {
    let eventHandler: ((event: unknown) => void) | undefined;
    const TOOL_EXECUTION_DURATION_MS = STALL_TIMEOUT_MS + 30000;

    const session = {
      sessionId: 'tool-exec-session',
      on: vi.fn().mockImplementation((handler: (event: unknown) => void) => {
        eventHandler = handler;
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockImplementation(() => new Promise((resolve) => {
        eventHandler?.({ type: 'tool.execution_start', data: { toolName: 'bash' } });
        setTimeout(() => {
          eventHandler?.({ type: 'tool.execution_complete', data: { toolName: 'bash' } });
          resolve(undefined);
        }, TOOL_EXECUTION_DURATION_MS);
      })),
    } as any;

    const mockClient = { createSession: vi.fn().mockResolvedValue(session) } as any;
    const promise = sendAndWaitWithAbort(makeWrapper(mockClient), { prompt: 'hi' } as any, TOOL_EXECUTION_DURATION_MS + 60000);

    const assertion = expect(promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(TOOL_EXECUTION_DURATION_MS + 60000);
    await assertion;
  });

  it('does NOT false-positive when the tool finishes (and sendAndWait resolves) before STALL_TIMEOUT_MS', async () => {
    let eventHandler: ((event: unknown) => void) | undefined;
    const FAST_TOOL_DURATION_MS = STALL_TIMEOUT_MS - 20000;

    const session = {
      sessionId: 'tool-exec-session-fast',
      on: vi.fn().mockImplementation((handler: (event: unknown) => void) => {
        eventHandler = handler;
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockImplementation(() => new Promise((resolve) => {
        eventHandler?.({ type: 'tool.execution_start', data: { toolName: 'bash' } });
        setTimeout(() => {
          eventHandler?.({ type: 'tool.execution_complete', data: { toolName: 'bash' } });
          resolve(undefined);
        }, FAST_TOOL_DURATION_MS);
      })),
    } as any;

    const mockClient = { createSession: vi.fn().mockResolvedValue(session) } as any;
    const promise = sendAndWaitWithAbort(makeWrapper(mockClient), { prompt: 'hi' } as any, 300000);
    await vi.advanceTimersByTimeAsync(FAST_TOOL_DURATION_MS + 1000);
    await expect(promise).resolves.toBeUndefined();
  });
});

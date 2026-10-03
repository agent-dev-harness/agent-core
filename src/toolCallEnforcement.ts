import {
  CopilotSession,
  MessageOptions,
  SessionEventHandler,
} from './copilotSdk/boundary';
import { SessionWrapper, SessionListenerEntry } from './copilotSdk/sessionWrapper';

export const LAST_MESSAGE_TRUNCATE_LENGTH = 2000;

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated, ${text.length} chars total]`;
}

export function trackLastAssistantMessage(session: CopilotSession): { readonly getText: () => string; readonly unsubscribe: () => void } {
  let text = '';
  const unsubscribe = session.on((event: unknown) => {
    if (!event || typeof event !== 'object') return;
    const ev = event as Record<string, unknown>;
    const evData = ev.data as Record<string, unknown> | undefined;
    if (ev.type === 'assistant.message') {
      text += (evData?.content as string | undefined) || '';
    } else if (ev.type === 'assistant.message_delta') {
      text += (evData?.delta as string | undefined) || (evData?.content as string | undefined) || '';
    }
  });
  return { getText: () => text, unsubscribe };
}

export const STALL_TIMEOUT_MS = 90000;
const STALL_POLL_INTERVAL_MS = 5000;

const SDK_HARD_TIMEOUT_CEILING_MS = 30 * 60 * 1000;

export interface StallError extends Error {
  readonly isStall: true;
}

function isStallError(err: unknown): err is StallError {
  return err instanceof Error && (err as Partial<StallError>).isStall === true;
}

export function createExecutionAwareSilenceTracker() {
  let lastEventAt = Date.now();
  let lastEventType: string | undefined;
  let toolExecutionActive = false;

  return {
    recordEvent(event: unknown): void {
      lastEventAt = Date.now();
      if (!event || typeof event !== 'object' || !('type' in event)) return;
      const ev = event as Record<string, unknown>;
      lastEventType = String(ev.type);
      if (ev.type === 'tool.execution_start') toolExecutionActive = true;
      if (ev.type === 'tool.execution_complete') toolExecutionActive = false;
    },
    silentForMs(): number | null {
      if (toolExecutionActive) return null;
      return Date.now() - lastEventAt;
    },
    lastEventType: () => lastEventType,
  };
}

const USAGE_TELEMETRY_LOG_LIMIT = 3;

export async function sendAndWaitWithAbort(
  wrapper: SessionWrapper,
  prompt: MessageOptions,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  onSessionId?: (sessionId: string) => void,
  additionalListeners?: SessionListenerEntry[],
): Promise<void> {
  let usageTelemetryLogCount = 0;
  const silenceTracker = createExecutionAwareSilenceTracker();

  const stallListener: SessionEventHandler = (event: unknown) => {
    silenceTracker.recordEvent(event);
    if (!event || typeof event !== 'object' || !('type' in event)) return;
    const ev = event as Record<string, unknown>;

    if (ev.type === 'tool.execution_start') {
      const data = ev.data as Record<string, unknown> | undefined;
      const toolName = data?.toolName;
      if (typeof toolName === 'string' && toolName.length > 0) {
        console.log(`[sendAndWaitWithAbort] tool used: ${toolName}`);
      } else {
        console.error(
          `[sendAndWaitWithAbort] UNEXPECTED EVENT SHAPE: 'tool.execution_start' event is missing a valid ` +
          `string 'toolName' in its data (got: ${JSON.stringify(data)}). This violates an assumption about ` +
          `the SDK's event contract -- investigate before trusting this event's downstream handling.`,
        );
      }
    }

    if (
      (ev.type === 'assistant.usage' || ev.type === 'session.usage_info') &&
      usageTelemetryLogCount < USAGE_TELEMETRY_LOG_LIMIT
    ) {
      usageTelemetryLogCount++;
      if (ev.data && typeof ev.data === 'object') {
        console.log(`[UsageTelemetry] session ${JSON.stringify(ev.data)}`);
      } else {
        console.error(
          `[sendAndWaitWithAbort] UNEXPECTED EVENT SHAPE: '${ev.type}' event has no usable 'data' object ` +
          `(got: ${JSON.stringify(ev.data)}). This violates an assumption about the SDK's event contract -- ` +
          `investigate before trusting this event's downstream handling.`,
        );
      }
    }
  };

  let stallTimer: ReturnType<typeof setInterval> | null = null;
  const stallPromise = new Promise<never>((_, reject) => {
    stallTimer = setInterval(() => {
      const elapsed = silenceTracker.silentForMs();
      if (elapsed !== null && elapsed > STALL_TIMEOUT_MS) {
        if (stallTimer) clearInterval(stallTimer);
        console.warn(
          `[sendAndWaitWithAbort] stall detected: no SDK event for ${elapsed}ms (threshold ${STALL_TIMEOUT_MS}ms); ` +
          `lastEventType=${silenceTracker.lastEventType() ?? 'none'}`,
        );
        const err = new Error(
          `Upstream stream stalled: no SDK event received for over ${STALL_TIMEOUT_MS / 1000}s.`,
        ) as StallError;
        (err as { isStall?: boolean }).isStall = true;
        reject(err);
      }
    }, STALL_POLL_INTERVAL_MS);
  });

  const racers: Promise<void>[] = [
    wrapper
      .sendAndWait(
        prompt,
        timeoutMs > STALL_TIMEOUT_MS ? Math.max(timeoutMs, SDK_HARD_TIMEOUT_CEILING_MS) : timeoutMs,
        [{ handler: stallListener }, ...(additionalListeners ?? [])],
        onSessionId,
      )
      .then(() => undefined),
    stallPromise,
  ];
  if (abortSignal) {
    racers.push(
      new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error('Session aborted by client or timeout'));
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
      }),
    );
  }

  try {
    await Promise.race(racers);
  } finally {
    if (stallTimer) clearInterval(stallTimer);
  }
}

export interface ForcedToolTurnOptions<T> {
  abortSignal?: AbortSignal;
  provider?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  getResult: () => T | undefined;
  availableTools?: string[];
  responseRequirements?: { toolCallExample?: string };
  listeners?: SessionListenerEntry[];
  maxStallRetries?: number;
  createFreshWrapper?: () => SessionWrapper;
  onSessionId?: (sessionId: string) => void;
}

function eventMatchesTargetTool(ev: Record<string, unknown>, targetTools: readonly string[]): boolean {
  return (
    (ev.type === 'tool.user_requested' && targetTools.includes((ev.data as any)?.toolName)) ||
    (ev.type === 'tool.execution_start' && targetTools.includes((ev.data as any)?.toolName)) ||
    (ev.type === 'external_tool.requested' && targetTools.includes((ev.data as any)?.toolName)) ||
    (ev.type === 'tool.execution_complete' && (ev.data as any)?.toolCallId && targetTools.some(t => (ev.data as any).toolCallId === `call-${t}`)) ||
    (ev.type === 'tool.execution_complete' && targetTools.includes((ev.data as any)?.toolName))
  );
}

function restrictToTargetTools(wrapper: SessionWrapper, turnAvailableTools: readonly string[], targetTools: readonly string[]): void {
  wrapper.disableTools(...turnAvailableTools);
  wrapper.enableTools(...targetTools);
}

export async function runForcedToolTurn<T>(
  wrapper: SessionWrapper,
  toolName: string | string[],
  initialPrompt: string,
  opts: ForcedToolTurnOptions<T>
): Promise<{ result: T; session: CopilotSession; lastAssistantText: string; toolCalled: boolean }> {
  let currentWrapper = wrapper;
  const timeoutMs = opts.timeoutMs ?? 300000;
  const maxRetries = opts.maxRetries ?? 2;
  const maxStallRetries = opts.maxStallRetries ?? 2;
  const responseRequirements = opts.responseRequirements ?? {};

  let toolCalled = false;
  const targetTools = Array.isArray(toolName) ? toolName : [toolName];
  const turnAvailableTools = opts.availableTools ?? targetTools;

  // An abandoned attempt's listeners can still receive events; the attempt id makes them no-ops.
  let currentAttemptId = 0;
  let assistantText = '';
  const makeAttemptListeners = (attemptId: number) => ({
    textListener: (event: unknown): void => {
      if (attemptId !== currentAttemptId) return;
      if (!event || typeof event !== 'object') return;
      const ev = event as Record<string, unknown>;
      const evData = ev.data as Record<string, unknown> | undefined;
      if (ev.type === 'assistant.message') {
        assistantText += (evData?.content as string | undefined) || '';
      } else if (ev.type === 'assistant.message_delta') {
        assistantText += (evData?.delta as string | undefined) || (evData?.content as string | undefined) || '';
      }
    },
    toolListener: (event: unknown): void => {
      if (attemptId !== currentAttemptId) return;
      const ev = event as Record<string, unknown>;
      if (eventMatchesTargetTool(ev, targetTools)) {
        toolCalled = true;
      }
    },
  });
  const callerListeners = opts.listeners ?? [];

  const sendWithStallRetry = async (
    promptOpts: { prompt: string; tool_choice?: unknown },
  ): Promise<void> => {
    let stallAttempt = 0;
    let currentPromptOpts = promptOpts;
    let resumeAttempted = false;
    while (true) {
      currentAttemptId++;
      const { textListener, toolListener } = makeAttemptListeners(currentAttemptId);
      toolCalled = false;
      assistantText = '';
      try {
        await sendAndWaitWithAbort(
          currentWrapper,
          currentPromptOpts as MessageOptions,
          timeoutMs,
          opts.abortSignal,
          opts.onSessionId,
          [{ handler: toolListener }, { handler: textListener }, ...callerListeners],
        );
        return;
      } catch (err) {
        if (!isStallError(err)) {
          throw err;
        }
        if (toolCalled) {
          console.warn(
            `[runForcedToolTurn] upstream went quiet after '${targetTools.join("', '")}' was already called; ` +
            `treating turn as complete instead of retrying.`,
          );
          return;
        }
        if (stallAttempt >= maxStallRetries) {
          throw err;
        }
        stallAttempt++;
        try {
          await currentWrapper.session?.disconnect?.();
        } catch (e) {
          console.warn(`[runForcedToolTurn] disconnect failed. ${e}`);
        }
        if (opts.createFreshWrapper) {
          if (!resumeAttempted && stallAttempt < maxStallRetries) {
            console.warn(
              `[runForcedToolTurn] upstream stall detected (attempt ${stallAttempt}/${maxStallRetries}); ` +
              `attempting to resume the stalled session before falling back to a fresh one...`,
            );
            resumeAttempted = true;
          } else {
            console.warn(
              `[runForcedToolTurn] resume attempt itself stalled (attempt ${stallAttempt}/${maxStallRetries}); ` +
              `starting a new session and retrying the original prompt...`,
            );
            currentWrapper = opts.createFreshWrapper();
            currentPromptOpts = { prompt: initialPrompt };
            resumeAttempted = false;
          }
        } else {
          console.warn(
            `[runForcedToolTurn] upstream stall detected (attempt ${stallAttempt}/${maxStallRetries}); ` +
            `resuming session and retrying the same prompt...`,
          );
        }
      }
    }
  };

  await sendWithStallRetry({ prompt: initialPrompt });

  let lastAssistantText = assistantText;

  let attempt = 0;

  while (!toolCalled && attempt < maxRetries) {
    attempt++;
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    console.warn(
      `[runForcedToolTurn] turn ended without ${toolNamesStr} being called ` +
      `(attempt ${attempt}/${maxRetries}); resuming session with restricted toolset...`
    );

    const exampleBlock = responseRequirements.toolCallExample
      ? `\n\nUse your tool-calling capability (a real function/tool call) -- not text in your message. Example of correctly-shaped arguments:\n\n${responseRequirements.toolCallExample}`
      : '';
    const nudge = lastAssistantText.trim()
      ? `You did not call any of: ${toolNamesStr}. Your last message was:\n"""\n${truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH)}\n"""\nYou must now call one of ${toolNamesStr} with your findings. Do not respond conversationally, do not ask clarifying questions, and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`
      : `You ended your turn without calling any of: ${toolNamesStr}. You must now call one of ${toolNamesStr} with your findings. Do not respond conversationally and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`;

    restrictToTargetTools(currentWrapper, turnAvailableTools, targetTools);

    const promptOpts = { prompt: nudge, tool_choice: undefined as any };
    if (opts.provider === 'openrouter') {
      promptOpts.tool_choice = { type: 'function', function: { name: targetTools[0] } };
    }

    await sendWithStallRetry(promptOpts);

    lastAssistantText = assistantText || lastAssistantText;
  }

  if (!toolCalled) {
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    const truncated = truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH);
    throw new Error(
      `Session ended without calling ${toolNamesStr} after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}. ` +
      `Model's last message: ${truncated || '(no assistant text captured)'}`
    );
  }

  let finalResult = opts.getResult();
  if (toolCalled && (finalResult === null || finalResult === undefined)) {
    finalResult = (true as unknown) as T;
  }

  return { result: finalResult as T, session: currentWrapper.session as CopilotSession, lastAssistantText, toolCalled };
}

// The SDK waits only 60s when no timeout is given, and Node clamps any timer
// delay above 2^31-1 ms to 1 ms, so this is the closest to "no deadline".
const NO_TURN_DEADLINE_MS = 2 ** 31 - 1;

export type ForcedToolTurnUntilTimeoutOptions<T> = Omit<
  ForcedToolTurnOptions<T>,
  'maxStallRetries' | 'createFreshWrapper'
>;

export async function runForcedToolTurnUntilTimeout<T>(
  wrapper: SessionWrapper,
  toolName: string | string[],
  initialPrompt: string,
  opts: ForcedToolTurnUntilTimeoutOptions<T>
): Promise<{ result: T; session: CopilotSession; lastAssistantText: string; toolCalled: boolean }> {
  const timeoutMs = opts.timeoutMs ?? NO_TURN_DEADLINE_MS;
  const maxRetries = opts.maxRetries ?? 2;
  const responseRequirements = opts.responseRequirements ?? {};

  let toolCalled = false;
  const targetTools = Array.isArray(toolName) ? toolName : [toolName];
  const turnAvailableTools = opts.availableTools ?? targetTools;
  let usageTelemetryLogCount = 0;

  let assistantText = '';
  const textListener = (event: unknown): void => {
    if (!event || typeof event !== 'object') return;
    const ev = event as Record<string, unknown>;
    const evData = ev.data as Record<string, unknown> | undefined;
    if (ev.type === 'assistant.message') {
      assistantText += (evData?.content as string | undefined) || '';
    } else if (ev.type === 'assistant.message_delta') {
      assistantText += (evData?.delta as string | undefined) || (evData?.content as string | undefined) || '';
    }
  };
  const callerListeners = opts.listeners ?? [];

  const toolListener = (event: unknown): void => {
      const ev = event as Record<string, unknown>;

      if (ev.type === 'tool.execution_start') {
        const data = ev.data as Record<string, unknown> | undefined;
        const toolName = data?.toolName;
        if (typeof toolName === 'string' && toolName.length > 0) {
          console.log(`[runForcedToolTurnUntilTimeout] tool used: ${toolName}`);
        } else {
          console.error(
            `[runForcedToolTurnUntilTimeout] UNEXPECTED EVENT SHAPE: 'tool.execution_start' event is missing a valid ` +
            `string 'toolName' in its data (got: ${JSON.stringify(data)}). This violates an assumption about ` +
            `the SDK's event contract -- investigate before trusting this event's downstream handling.`,
          );
        }
      }

      if (
        (ev.type === 'assistant.usage' || ev.type === 'session.usage_info') &&
        usageTelemetryLogCount < USAGE_TELEMETRY_LOG_LIMIT
      ) {
        usageTelemetryLogCount++;
        if (ev.data && typeof ev.data === 'object') {
          console.log(`[UsageTelemetry] session ${JSON.stringify(ev.data)}`);
        } else {
          console.error(
            `[runForcedToolTurnUntilTimeout] UNEXPECTED EVENT SHAPE: '${ev.type}' event has no usable 'data' object ` +
            `(got: ${JSON.stringify(ev.data)}). This violates an assumption about the SDK's event contract -- ` +
            `investigate before trusting this event's downstream handling.`,
          );
        }
      }

      if (eventMatchesTargetTool(ev, targetTools)) {
        toolCalled = true;
      }
  };

  const sendUntilTimeout = async (promptOpts: MessageOptions): Promise<void> => {
    toolCalled = false;
    assistantText = '';
    const racers: Promise<void>[] = [
      wrapper
        .sendAndWait(
          promptOpts,
          timeoutMs,
          [{ handler: toolListener }, { handler: textListener }, ...callerListeners],
          opts.onSessionId,
        )
        .then(() => undefined),
    ];
    if (opts.abortSignal) {
      racers.push(
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error('Session aborted by client or timeout'));
          if (opts.abortSignal!.aborted) onAbort();
          else opts.abortSignal!.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }
    await Promise.race(racers);
  };

  await sendUntilTimeout({ prompt: initialPrompt } as MessageOptions);

  let lastAssistantText = assistantText;

  let attempt = 0;

  while (!toolCalled && attempt < maxRetries) {
    attempt++;
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    console.warn(
      `[runForcedToolTurnUntilTimeout] turn ended without ${toolNamesStr} being called ` +
      `(attempt ${attempt}/${maxRetries}); resuming session with restricted toolset...`
    );

    const exampleBlock = responseRequirements.toolCallExample
      ? `\n\nUse your tool-calling capability (a real function/tool call) -- not text in your message. Example of correctly-shaped arguments:\n\n${responseRequirements.toolCallExample}`
      : '';
    const nudge = lastAssistantText.trim()
      ? `You did not call any of: ${toolNamesStr}. Your last message was:\n"""\n${truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH)}\n"""\nYou must now call one of ${toolNamesStr} with your findings. Do not respond conversationally, do not ask clarifying questions, and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`
      : `You ended your turn without calling any of: ${toolNamesStr}. You must now call one of ${toolNamesStr} with your findings. Do not respond conversationally and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`;

    restrictToTargetTools(wrapper, turnAvailableTools, targetTools);

    const promptOpts: { prompt: string; tool_choice?: unknown } = { prompt: nudge, tool_choice: undefined as any };
    if (opts.provider === 'openrouter') {
      promptOpts.tool_choice = { type: 'function', function: { name: targetTools[0] } };
    }

    await sendUntilTimeout(promptOpts as MessageOptions);

    lastAssistantText = assistantText || lastAssistantText;
  }

  if (!toolCalled) {
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    const truncated = truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH);
    throw new Error(
      `Session ended without calling ${toolNamesStr} after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}. ` +
      `Model's last message: ${truncated || '(no assistant text captured)'}`
    );
  }

  let finalResult = opts.getResult();
  if (toolCalled && (finalResult === null || finalResult === undefined)) {
    finalResult = (true as unknown) as T;
  }

  return { result: finalResult as T, session: wrapper.session as CopilotSession, lastAssistantText, toolCalled };
}

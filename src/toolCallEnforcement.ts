import {
  MessageOptions,
} from './copilotSdk/boundary';
import { NO_TURN_DEADLINE_MS, SessionWrapper, SessionListenerEntry } from './copilotSdk/sessionWrapper';

export const LAST_MESSAGE_TRUNCATE_LENGTH = 2000;

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated, ${text.length} chars total]`;
}

const USAGE_TELEMETRY_LOG_LIMIT = 3;

export type ForcedToolTurnLogger = Pick<Console, 'log' | 'warn' | 'error'>;

export interface ForcedToolTurnUntilTimeoutOptions<T> {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  getResult: () => T | undefined;
  availableTools?: string[];
  responseRequirements?: { toolCallExample?: string };
  listeners?: SessionListenerEntry[];
  onSessionId?: (sessionId: string) => void;
  // Where diagnostics go; defaults to console.
  logger?: ForcedToolTurnLogger;
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

// tool.execution_complete carries only the call id, so a target call is recognised by the id its
// tool.execution_start announced.
function targetCallId(ev: Record<string, unknown>, targetTools: readonly string[]): string | undefined {
  const data = ev.data as { toolName?: unknown; toolCallId?: unknown } | undefined;
  return ev.type === 'tool.execution_start' && targetTools.includes(data?.toolName as string) && typeof data?.toolCallId === 'string'
    ? data.toolCallId
    : undefined;
}

function restrictToTargetTools(wrapper: SessionWrapper, turnAvailableTools: readonly string[], targetTools: readonly string[]): void {
  wrapper.disableTools(...turnAvailableTools);
  wrapper.enableTools(...targetTools);
}

export async function runForcedToolTurnUntilTimeout<T>(
  wrapper: SessionWrapper,
  toolName: string | string[],
  initialPrompt: string,
  opts: ForcedToolTurnUntilTimeoutOptions<T>
): Promise<{ result: T; lastAssistantText: string; toolCalled: boolean }> {
  const timeoutMs = opts.timeoutMs ?? NO_TURN_DEADLINE_MS;
  const maxRetries = opts.maxRetries ?? 2;
  const responseRequirements = opts.responseRequirements ?? {};
  const logger = opts.logger ?? console;

  let toolCalled = false;
  // A target call that fails (bad arguments, a throwing handler) doesn't count as the answer.
  const targetCallIds = new Set<string>();
  let succeededCalls = 0;
  let failedCalls = 0;
  let lastFailure = '';
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
          logger.log(`[runForcedToolTurnUntilTimeout] tool used: ${toolName}`);
        } else {
          logger.error(
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
          logger.log(`[UsageTelemetry] session ${JSON.stringify(ev.data)}`);
        } else {
          logger.error(
            `[runForcedToolTurnUntilTimeout] UNEXPECTED EVENT SHAPE: '${ev.type}' event has no usable 'data' object ` +
            `(got: ${JSON.stringify(ev.data)}). This violates an assumption about the SDK's event contract -- ` +
            `investigate before trusting this event's downstream handling.`,
          );
        }
      }

      const startedId = targetCallId(ev, targetTools);
      if (startedId) targetCallIds.add(startedId);
      if (ev.type === 'tool.execution_complete') {
        const data = ev.data as { toolCallId?: unknown; success?: unknown; error?: { message?: unknown } } | undefined;
        if (typeof data?.toolCallId === 'string' && targetCallIds.has(data.toolCallId)) {
          if (data.success === false) {
            failedCalls++;
            lastFailure = typeof data.error?.message === 'string' ? data.error.message : 'the call failed';
          } else {
            succeededCalls++;
          }
        }
      }

      if (eventMatchesTargetTool(ev, targetTools)) {
        toolCalled = true;
      }
  };

  const targetCallFailed = (): boolean => failedCalls > 0 && succeededCalls === 0;

  const sendUntilTimeout = async (promptOpts: MessageOptions): Promise<void> => {
    toolCalled = false;
    targetCallIds.clear();
    succeededCalls = 0;
    failedCalls = 0;
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

  while ((!toolCalled || targetCallFailed()) && attempt < maxRetries) {
    attempt++;
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    logger.warn(
      `[runForcedToolTurnUntilTimeout] turn ended without ${toolNamesStr} being called successfully ` +
      `(attempt ${attempt}/${maxRetries}); resuming session with restricted toolset...`
    );

    const exampleBlock = responseRequirements.toolCallExample
      ? `\n\nUse your tool-calling capability (a real function/tool call) -- not text in your message. Example of correctly-shaped arguments:\n\n${responseRequirements.toolCallExample}`
      : '';
    const nudge = targetCallFailed()
      ? `Your call to ${toolNamesStr} failed: ${truncate(lastFailure, LAST_MESSAGE_TRUNCATE_LENGTH)}\nYou must now call one of ${toolNamesStr} again with corrected arguments. Do not respond conversationally and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`
      : lastAssistantText.trim()
      ? `You did not call any of: ${toolNamesStr}. Your last message was:\n"""\n${truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH)}\n"""\nYou must now call one of ${toolNamesStr} with your findings. Do not respond conversationally, do not ask clarifying questions, and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`
      : `You ended your turn without calling any of: ${toolNamesStr}. You must now call one of ${toolNamesStr} with your findings. Do not respond conversationally and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`;

    restrictToTargetTools(wrapper, turnAvailableTools, targetTools);

    await sendUntilTimeout({ prompt: nudge });

    lastAssistantText = assistantText || lastAssistantText;
  }

  if (!toolCalled || targetCallFailed()) {
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    if (toolCalled) {
      throw new Error(
        `Every call to ${toolNamesStr} failed after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}. ` +
        `Last error: ${truncate(lastFailure, LAST_MESSAGE_TRUNCATE_LENGTH)}`
      );
    }
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

  return { result: finalResult as T, lastAssistantText, toolCalled };
}

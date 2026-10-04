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

export interface ForcedToolTurnUntilTimeoutOptions<T> {
  abortSignal?: AbortSignal;
  provider?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  getResult: () => T | undefined;
  availableTools?: string[];
  responseRequirements?: { toolCallExample?: string };
  listeners?: SessionListenerEntry[];
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

export async function runForcedToolTurnUntilTimeout<T>(
  wrapper: SessionWrapper,
  toolName: string | string[],
  initialPrompt: string,
  opts: ForcedToolTurnUntilTimeoutOptions<T>
): Promise<{ result: T; lastAssistantText: string; toolCalled: boolean }> {
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

  return { result: finalResult as T, lastAssistantText, toolCalled };
}

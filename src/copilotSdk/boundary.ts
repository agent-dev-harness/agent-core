import { CopilotClient as BaseCopilotClient, ToolSet } from '@github/copilot-sdk';

export { ToolSet };

import type {
  CopilotSession,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  Tool,
} from '@github/copilot-sdk';
import type { TurnToolInvocation } from './sessionWrapper';

export type {
  CopilotSession,
  PermissionRequest,
  AssistantMessageDeltaEvent,
  AssistantMessageEvent,
  AssistantReasoningDeltaEvent,
  AssistantStreamingDeltaEvent,
  PermissionRequestResult,
  ProviderConfig as SdkProviderConfig,
  SessionCapabilities,
  SessionConfig,
  SessionEvent,
  SessionEventHandler,
  SessionEventType,
  TypedSessionEventHandler,
  MessageOptions,
  Tool,
  ToolExecutionCompleteContent,
  ToolExecutionCompleteEvent,
  ToolInvocation,
} from '@github/copilot-sdk';

// SessionWrapper wraps every custom tool, so the handler gets a TurnToolInvocation. T types only
// the handler's arguments: the result is a plain Tool, so it fits SessionWrapper's custom list.
export function defineTool<T = unknown>(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: (args: T, invocation: TurnToolInvocation) => Promise<unknown>
): Tool {
  return {
    name,
    description,
    parameters,
    handler: handler as Tool['handler'],
  };
}

export class CopilotClient extends BaseCopilotClient {
  override async createSession(
    config: SessionConfig & { autoApproveAll?: boolean }
  ): Promise<CopilotSession> {
    const { autoApproveAll = true, ...baseConfig } = config;

    const onPermissionRequest = autoApproveAll
      ? async (req: PermissionRequest): Promise<PermissionRequestResult> => {
          return { kind: 'approve-once' };
        }
      : baseConfig.onPermissionRequest;

    return super.createSession({
      ...baseConfig,
      onPermissionRequest,
    });
  }

  override async resumeSession(
    sessionId: string,
    config: SessionConfig & { autoApproveAll?: boolean }
  ): Promise<CopilotSession> {
    const { autoApproveAll = true, ...baseConfig } = config;

    const onPermissionRequest = autoApproveAll
      ? async (req: PermissionRequest): Promise<PermissionRequestResult> => {
          return { kind: 'approve-once' };
        }
      : baseConfig.onPermissionRequest;

    return super.resumeSession(sessionId, {
      ...baseConfig,
      onPermissionRequest,
    });
  }
}

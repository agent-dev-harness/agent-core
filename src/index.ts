// Public API of agent-core. Widen it only when a consumer needs a symbol,
// since every export is a contract with every consumer.
export {
  CopilotClient,
  defineTool,
} from './copilotSdk/boundary';
export type {
  CopilotSession,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  SdkProviderConfig,
  SessionConfig,
  SessionEvent,
  Tool,
  ToolExecutionCompleteContent,
  ToolInvocation,
  TypedSessionEventHandler,
} from './copilotSdk/boundary';

export { SessionWrapper } from './copilotSdk/sessionWrapper';
export type {
  SessionListenerEntry,
  SessionWrapperBaseConfig,
  SessionWrapperToolsConfig,
} from './copilotSdk/sessionWrapper';

export {
  FORCED_TOOL_TURN_HARD_TIMEOUT_MS,
  runForcedToolTurnUntilTimeout,
} from './toolCallEnforcement';

export {
  SlidingWindowCircularBuffer,
  cleanSubprocessLogs,
  clearCleanCache,
  enforceWorkingMemoryTruncation,
} from './contextManager';

export {
  buildExecOptions,
  makeRunTerminalDockerHandler,
  parseExecToolArgs,
  truncateExecResult,
} from './execTool';

export { ProviderRegistry } from './providerRegistry';
export type {
  ExecutionConfig,
  ProviderConfig,
  ProviderRegistryConfig,
} from './providerRegistry';

export { PROVIDERS, isProviderType } from './config/models';
export type { ModelProviderConfig, ProviderType } from './config/models';
export { RUN_TERMINAL_DOCKER_TOOL } from './config/tools';

import {
  AssistantMessageEvent,
  CopilotClient,
  CopilotSession,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  SessionEventHandler,
  SessionEventType,
  Tool,
  ToolInvocation,
  TypedSessionEventHandler,
} from './boundary';

type ConfigOwnedKeys =
  | 'availableTools'
  | 'tools'
  | 'systemMessage'
  | 'autoApproveAll'
  | 'onPermissionRequest'
  | 'model';

// The SDK waits only 60s when no timeout is given, and Node clamps any timer
// delay above 2^31-1 ms to 1 ms, so this is the closest to "no deadline".
export const NO_TURN_DEADLINE_MS = 2 ** 31 - 1;

// What SessionWrapper passes to custom tool handlers. abortSignal fires when the
// current turn is aborted, so a tool can stop work whose result would be discarded.
export type TurnToolInvocation = ToolInvocation & { abortSignal: AbortSignal };

export type SessionWrapperBaseConfig = Omit<SessionConfig, ConfigOwnedKeys>;

export type SessionListenerEntry =
  | { [K in SessionEventType]: { type: K; handler: TypedSessionEventHandler<K> } }[SessionEventType]
  | { handler: SessionEventHandler };

export interface SessionWrapperToolsConfig {
  readonly builtins?: readonly string[];
  readonly custom?: readonly Tool[];
}

const BUILTIN_TOOL_PERMISSION_KIND: Readonly<Record<string, string>> = {
  view: 'read',
  edit: 'write',
  grep: 'read',
  glob: 'read',
};

function extractRequestedToolName(req: PermissionRequest): string {
  switch (req.kind) {
    case 'mcp':
    case 'custom-tool':
    case 'hook':
      return req.toolName;
    case 'shell':
    case 'write':
    case 'read':
    case 'url':
    case 'memory':
    case 'extension-management':
    case 'extension-permission-access':
      return req.kind;
    default: {
      const unknownReq = req as { kind: string };
      return unknownReq.kind;
    }
  }
}

function buildEnablementNotice(enabledTools: readonly string[]): string {
  if (enabledTools.length === 0) {
    return (
      '# Tools enabled this turn\n' +
      'No tools are currently enabled. Any tool call will be rejected, even to a tool whose schema you can see.'
    );
  }
  return (
    '# Tools enabled this turn\n' +
    `Only the following tools are currently enabled and may be called: ${enabledTools.join(', ')}. ` +
    'A call to any other tool -- including one whose schema is visible to you -- will be rejected.'
  );
}

function buildCustomizeSystemMessage(callerContent: string | undefined): SessionConfig['systemMessage'] {
  return { mode: 'customize', content: callerContent ?? '' };
}

function buildSystemPromptUpdateNotice(
  previousSystemPrompt: string | undefined,
  nextSystemPrompt: string | undefined
): string | undefined {
  if (previousSystemPrompt === nextSystemPrompt) {
    return undefined;
  }
  const preamble =
    '# Session update\n' +
    "This session's additional operating instructions changed since the last turn. " +
    'The system prompt shown above is not being regenerated (it must stay fixed for ' +
    'prompt-cache reasons), so this note is how the change reaches you.';
  if (!nextSystemPrompt) {
    return `${preamble} There are no additional operating instructions any more: disregard the ones in the system prompt.`;
  }
  return (
    `${preamble} The new instructions below replace the additional operating instructions in the system prompt:\n\n` +
    `<operating_instructions>\n${nextSystemPrompt}\n</operating_instructions>`
  );
}

function withTurnSignal(tool: Tool, turnSignal: () => AbortSignal): Tool {
  const handler = tool.handler;
  if (!handler) return tool;
  return {
    ...tool,
    handler: (args, invocation) => {
      const turnInvocation: TurnToolInvocation = { ...invocation, abortSignal: turnSignal() };
      return handler(args, turnInvocation);
    },
  };
}

export class SessionWrapper {
  private readonly _allToolNames: readonly string[];

  private readonly _allToolNamesSet: ReadonlySet<string>;

  private readonly _kindSiblings: ReadonlyMap<string, readonly string[]>;

  private readonly _customTools: ReadonlyMap<string, Tool>;

  private readonly _enabledTools: Set<string>;

  private _systemPrompt: string | undefined = undefined;

  private _modelName: string | undefined = undefined;

  private _session: CopilotSession | undefined = undefined;

  private _creatingSession: Promise<CopilotSession> | undefined = undefined;

  private _sessionModel: string | undefined = undefined;

  private _frozenSystemMessage: SessionConfig['systemMessage'] | undefined = undefined;

  private _announcedSystemPrompt: string | undefined = undefined;

  private _turnAbort = new AbortController();

  private _unsubscribeAbort: (() => void) | undefined = undefined;

  constructor(
    private readonly _client?: CopilotClient,
    toolsConfig: SessionWrapperToolsConfig = {},
    private readonly _baseConfig: SessionWrapperBaseConfig = {}
  ) {
    const builtins = [...(toolsConfig.builtins ?? [])];
    if (builtins.includes('bash')) {
      throw new Error(
        "SessionWrapper: the built-in 'bash' tool runs on the host and is not allowed; use run_terminal_docker instead."
      );
    }
    const customEntries: [string, Tool][] = (toolsConfig.custom ?? []).map((tool) => [
      tool.name,
      withTurnSignal(tool, () => this._turnAbort.signal),
    ]);
    this._customTools = new Map(customEntries);
    this._allToolNames = [...builtins, ...this._customTools.keys()];
    this._allToolNamesSet = new Set(this._allToolNames);
    this._enabledTools = new Set(this._allToolNames);

    const kindSiblings = new Map<string, string[]>();
    for (const name of builtins) {
      const kind = BUILTIN_TOOL_PERMISSION_KIND[name];
      if (kind === undefined) {
        continue;
      }
      const siblings = kindSiblings.get(kind) ?? [];
      siblings.push(name);
      kindSiblings.set(kind, siblings);
    }
    this._kindSiblings = kindSiblings;
  }

  /** @deprecated Use abort() and disconnect(); calling the raw session skips the wrapper's notices and defaults. */
  get session(): CopilotSession | undefined {
    return this._session;
  }

  async abort(): Promise<void> {
    await this._session?.abort();
  }

  // The next sendAndWait creates a fresh session rather than resuming this one.
  async disconnect(): Promise<void> {
    const session = this._session;
    this._unsubscribeAbort?.();
    this._unsubscribeAbort = undefined;
    this._session = undefined;
    this._sessionModel = undefined;
    this._frozenSystemMessage = undefined;
    this._announcedSystemPrompt = undefined;
    await session?.disconnect();
  }

  enableTools(...names: readonly string[]): this {
    this._setEnablement(names, true);
    return this;
  }

  disableTools(...names: readonly string[]): this {
    this._setEnablement(names, false);
    return this;
  }

  isToolEnabled(name: string): boolean {
    this._assertKnownTools('isToolEnabled', [name]);
    return this._enabledTools.has(name);
  }

  private _assertKnownTools(methodName: string, names: readonly string[]): void {
    for (const name of names) {
      if (!this._allToolNamesSet.has(name)) {
        throw new Error(
          `SessionWrapper.${methodName}: unknown tool '${name}' -- it was not supplied to the constructor's ` +
            'toolsConfig, and no tool can be added after construction.'
        );
      }
    }
  }

  private _setEnablement(names: readonly string[], enabled: boolean): void {
    this._assertKnownTools(enabled ? 'enableTools' : 'disableTools', names);
    for (const name of names) {
      if (enabled) {
        this._enabledTools.add(name);
      } else {
        this._enabledTools.delete(name);
      }
    }
  }

  setSystemPrompt(content: string | undefined): this {
    this._systemPrompt = content;
    return this;
  }

  setModelName(modelName: string): this {
    this._modelName = modelName;
    return this;
  }

  private _onPermissionRequest = async (
    req: PermissionRequest,
    _invocation: { sessionId: string }
  ): Promise<PermissionRequestResult> => {
    if (req.kind === 'shell') {
      return {
        kind: 'reject',
        feedback: 'Shell commands on the host are not allowed. Use run_terminal_docker instead.',
      };
    }
    const requestedTool = extractRequestedToolName(req);
    // view, grep and glob all arrive as kind 'read', so approve only if every tool sharing the kind is enabled.
    const siblings = this._kindSiblings.get(requestedTool);
    const isApproved =
      siblings !== undefined && siblings.length > 0
        ? siblings.every((name) => this._enabledTools.has(name))
        : this._enabledTools.has(requestedTool);
    if (isApproved) {
      return { kind: 'approve-once' };
    }
    return {
      kind: 'reject',
      feedback: `Tool '${requestedTool}' is not currently enabled for this session.`,
    };
  };

  _createConfig(): Pick<SessionConfig, 'availableTools' | 'tools' | 'systemMessage' | 'model'> & {
    autoApproveAll: false;
    onPermissionRequest: (
      req: PermissionRequest,
      invocation: { sessionId: string }
    ) => Promise<PermissionRequestResult>;
  } {
    // Changing tools or availableTools between turns busts the prompt cache, so both stay fixed
    // and enablement is enforced in _onPermissionRequest instead.
    return {
      availableTools: this._allToolNames as SessionConfig['availableTools'],
      tools: [...this._customTools.values()] as SessionConfig['tools'],
      systemMessage: this._frozenSystemMessage ?? buildCustomizeSystemMessage(this._systemPrompt),
      model: this._modelName,
      autoApproveAll: false,
      onPermissionRequest: this._onPermissionRequest,
    };
  }

  async sendAndWait(
    prompt: string | MessageOptions,
    timeout?: number,
    listeners?: SessionListenerEntry[],
    onSessionId?: (sessionId: string) => void
  ): Promise<AssistantMessageEvent | undefined> {
    if (!this._client) {
      throw new Error('SessionWrapper.sendAndWait: no CopilotClient was supplied to this instance.');
    }
    const modelName = this._modelName;
    if (!modelName) {
      throw new Error('SessionWrapper.sendAndWait: no model name was set. Call setModelName() first.');
    }

    const enabledSubset = this._allToolNames.filter((name) => this._enabledTools.has(name));
    const noticeParts = [buildEnablementNotice(enabledSubset)];
    const isResume = this._session !== undefined;
    if (isResume) {
      const systemPromptNotice = buildSystemPromptUpdateNotice(this._announcedSystemPrompt, this._systemPrompt);
      if (systemPromptNotice) {
        noticeParts.push(systemPromptNotice);
      }
    }
    const notice = noticeParts.join('\n\n');

    const effectivePrompt: string | MessageOptions =
      typeof prompt === 'string' ? `${notice}\n\n${prompt}` : { ...prompt, prompt: `${notice}\n\n${prompt.prompt}` };

    if (!this._session) {
      // Concurrent first turns share one createSession call instead of each creating a session.
      if (!this._creatingSession) {
        const config = this._createConfig();
        this._frozenSystemMessage = config.systemMessage;
        this._sessionModel = config.model;
        this._creatingSession = this._client
          .createSession({
            ...this._baseConfig,
            ...config,
            // Last, so neither spread above can disable it.
            largeOutput: { enabled: true, maxSizeBytes: 51200 },
          })
          .finally(() => {
            this._creatingSession = undefined;
          });
      }
      this._session = await this._creatingSession;
    } else {
      // The SDK forgets custom tools and systemMessage on resume, and boundary.ts defaults
      // autoApproveAll to true, which would bypass _onPermissionRequest.
      const resumeConfig = this._createConfig();
      this._session = await this._client.resumeSession(this._session.sessionId, {
        onPermissionRequest: this._onPermissionRequest,
        autoApproveAll: false,
        tools: resumeConfig.tools,
        availableTools: resumeConfig.availableTools,
        systemMessage: this._frozenSystemMessage,
      });
      if (modelName !== this._sessionModel) {
        await this._session.setModel(modelName);
        this._sessionModel = modelName;
      }
    }

    this._announcedSystemPrompt = this._systemPrompt;

    this._turnAbort = new AbortController();
    this._unsubscribeAbort?.();
    this._unsubscribeAbort = this._session.on((event) => {
      if (event.type === 'abort') this._turnAbort.abort();
    });

    onSessionId?.(this._session.sessionId);

    const unsubscribers = (listeners ?? []).map((l) =>
      'type' in l ? this._session!.on(l.type, l.handler as TypedSessionEventHandler<typeof l.type>) : this._session!.on(l.handler)
    );
    try {
      return await (typeof effectivePrompt === 'string'
        ? this._session.sendAndWait(effectivePrompt, timeout ?? NO_TURN_DEADLINE_MS)
        : this._session.sendAndWait(effectivePrompt, timeout ?? NO_TURN_DEADLINE_MS));
    } finally {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    }
  }
}

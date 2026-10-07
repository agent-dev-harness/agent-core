import * as http from "node:http";
import type { AddressInfo } from "node:net";

// One OpenAI-compatible chat-completions request, as the CLI sent it.
export interface ChatRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: ChatRequestBody;
}

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ChatRequestBody {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: { type: string; function: { name: string; description?: string; parameters?: unknown } }[];
  [key: string]: unknown;
}

export interface ScriptedToolCall {
  name: string;
  // An object is JSON-encoded; a string is sent as-is, so a test can send malformed arguments.
  args: unknown;
}

export type ScriptedReply = ({ text: string } | { toolCalls: ScriptedToolCall[] }) & { delayMs?: number };

// A step sees the request it answers, so it can assert on what the model was shown (the
// previous tool result, the prompt, the tool list) before choosing the reply.
export type ScriptedStep = (request: ChatRequestBody) => ScriptedReply | Promise<ScriptedReply>;

// Stands in for the model behind a bring-your-own-key `openai` provider. Each chat-completions
// request takes the next step from `steps`; every request is kept in `requests`, so a test sees
// exactly what Copilot sent the model. Unlike CapiProxy there is no snapshot matching: the
// script is code, in the test.
export class ScriptedModel {
  readonly steps: ScriptedStep[] = [];
  readonly requests: ChatRequest[] = [];
  // Requests that arrived after the script ran out; they get a fixed text reply so the turn ends.
  unscriptedRequests = 0;
  private server: http.Server | undefined;
  private replyCount = 0;

  get url(): string {
    if (!this.server) throw new Error("ScriptedModel: call start() first.");
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  // For SessionWrapper's base config, or createSession's `provider`.
  provider(): { type: "openai"; baseUrl: string; apiKey: string } {
    return { type: "openai", baseUrl: this.url, apiKey: "scripted-model-key" };
  }

  // For CopilotClient's `env`: keeps the CLI's Copilot API calls on this server too.
  env(): Record<string, string | undefined> {
    return { ...process.env, COPILOT_API_URL: this.url };
  }

  push(...steps: ScriptedStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void this.handle(req, Buffer.concat(chunks).toString("utf8"), res).catch((err: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: `ScriptedModel step threw: ${String(err)}` } }));
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return this.url;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, rawBody: string, res: http.ServerResponse): Promise<void> {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    if (pathname.endsWith("/copilot_internal/v2/token")) {
      return sendJson(res, {
        token: "scripted-model-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        endpoints: { api: this.url },
      });
    }
    if (!pathname.endsWith("/chat/completions")) {
      return sendJson(res, pathname.endsWith("/models") ? { data: [] } : {});
    }

    const body = JSON.parse(rawBody) as ChatRequestBody;
    this.requests.push({ url: req.url ?? "", headers: req.headers, body });
    const step = this.steps.shift();
    if (!step) this.unscriptedRequests++;
    const reply: ScriptedReply = step ? await step(body) : { text: "(ScriptedModel: no steps left)" };
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));

    const id = `chatcmpl-scripted-${++this.replyCount}`;
    const toolCalls = ("toolCalls" in reply ? reply.toolCalls : []).map((call, index) => ({
      id: `call_${this.replyCount}_${index}`,
      type: "function" as const,
      function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) },
    }));
    const text = "text" in reply ? reply.text : null;
    const finishReason = toolCalls.length ? "tool_calls" : "stop";
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

    if (!body.stream) {
      const message = toolCalls.length
        ? { role: "assistant", content: null, tool_calls: toolCalls }
        : { role: "assistant", content: text ?? "" };
      return sendJson(res, {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
      });
    }
    const delta = toolCalls.length
      ? { role: "assistant", tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }
      : { role: "assistant", content: text ?? "" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function sendJson(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function contentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

// The tool results the model was shown, oldest first, as text.
export function toolResults(body: ChatRequestBody): string[] {
  return body.messages.filter((m) => m.role === "tool").map((m) => contentText(m.content));
}

export function lastToolResult(body: ChatRequestBody): string | undefined {
  return toolResults(body).at(-1);
}

// The system prompt the model was shown.
export function systemPrompt(body: ChatRequestBody): string | undefined {
  const system = body.messages.find((m) => m.role === "system");
  return system === undefined ? undefined : contentText(system.content);
}

export function toolCall(name: string, args: unknown = {}): ScriptedReply {
  return { toolCalls: [{ name, args }] };
}

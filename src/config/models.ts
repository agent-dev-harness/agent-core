/**
 * Provider-type vocabulary: the data every consumer (server, UI, scripts)
 * agrees on. Role/tier model configuration is out of scope for this package
 * (see the README): the caller owns it and injects it into ProviderRegistry.
 */

export const PROVIDERS = [
  "copilot-native",
  "openai",
  "anthropic",
  "gemini",
  "local",
  "openrouter",
] as const;
export type ProviderType = (typeof PROVIDERS)[number];

export function isProviderType(p: unknown): p is ProviderType {
  return typeof p === "string" && (PROVIDERS as readonly string[]).includes(p);
}

export interface ModelProviderConfig {
  readonly provider: ProviderType;
  readonly model: string;
  readonly tokenRatio?: number;
}

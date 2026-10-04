export const PROVIDERS = ["copilot-native", "openrouter"] as const;
export type ProviderType = (typeof PROVIDERS)[number];

export function isProviderType(p: unknown): p is ProviderType {
  return typeof p === "string" && (PROVIDERS as readonly string[]).includes(p);
}

export interface ModelProviderConfig {
  readonly provider: ProviderType;
  readonly model: string;
  readonly tokenRatio?: number;
}

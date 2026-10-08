export const PROVIDERS = ["copilot-native", "openrouter"] as const;
export type ProviderType = (typeof PROVIDERS)[number];

export function isProviderType(p: unknown): p is ProviderType {
  return typeof p === "string" && (PROVIDERS as readonly string[]).includes(p);
}

// M narrows the model names a caller may use; the default accepts any string.
export interface ModelProviderConfig<M extends string = string> {
  readonly provider: ProviderType;
  readonly model: M;
  readonly tokenRatio?: number;
}

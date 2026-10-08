import { ModelProviderConfig, ProviderType } from './config/models';

export const OPENROUTER_SESSION_ID_HEADER = 'x-openrouter-session-id';

export interface ProviderConfig {
  type: 'openai' | 'anthropic' | 'azure';
  baseUrl: string;
  apiKey?: string;
  wireApi?: 'completions' | 'responses';
  headers?: Record<string, string>;
}

export interface ExecutionConfig {
  model: string;
  providerType: ProviderType;
  provider?: ProviderConfig;
}

export interface ProviderRegistryConfig<M extends string = string> {
  tierModels: readonly M[];
  roleModels: readonly ModelProviderConfig<M>[];
  allConfigs: readonly ModelProviderConfig<M>[];
}

const EMPTY_KNOWN_MODELS: ProviderRegistryConfig<never> = { tierModels: [], roleModels: [], allConfigs: [] };

// Model names are checked by the type parameter, not at runtime: a name is sent to its provider
// as given, and the provider rejects one it doesn't know. M is only narrowed when the caller
// passes it (NoInfer), so a registry built from literal names still takes a model held in a string.
export class ProviderRegistry<M extends string = string> {
  private apiKey: string | undefined;
  private readonly known: ProviderRegistryConfig<M>;

  constructor(apiKey: string | undefined, knownModels?: ProviderRegistryConfig<NoInfer<M>>) {
    this.apiKey = apiKey;
    this.known = knownModels ?? EMPTY_KNOWN_MODELS;
  }

  public getMappedModel(modelName?: M): string {
    if (!modelName) {
      const fallback = this.known.tierModels[0];
      if (!fallback) {
        throw new Error('ProviderRegistry: no model was given and no tierModels are configured to fall back on.');
      }
      return fallback;
    }
    return modelName.replace('models/', '').trim();
  }

  public getProviderType(input: M | ModelProviderConfig<M>): ProviderType {
    if (typeof input === 'object' && input !== null) {
      return input.provider;
    }
    const model = this.getMappedModel(input);
    return this.known.allConfigs.find(t => t.model === model)?.provider ?? 'openrouter';
  }

  public getProviderConfig(provider: ProviderType, modelName: string): ProviderConfig | undefined {
    if (provider === 'copilot-native') {
      return undefined;
    }

    const apiKey = process.env.OPENROUTER_API_KEY || (this.apiKey !== 'mock-key' ? this.apiKey : undefined);
    if (!apiKey) {
      throw new Error('Missing API key for OpenRouter provider. Expected OPENROUTER_API_KEY to be set.');
    }

    const proxyBaseUrl = process.env.COPILOT_API_URL ? `${process.env.COPILOT_API_URL}/api/providers/openrouter/api/v1/` : `http://localhost:${process.env.PORT || 3000}/api/providers/openrouter/api/v1/`;
    let finalBaseUrl = process.env.OPENROUTER_BASE_URL || proxyBaseUrl;
    finalBaseUrl = finalBaseUrl.trim();
    finalBaseUrl = finalBaseUrl.replace(/\/chat\/completions\/?$/, '/');
    finalBaseUrl = finalBaseUrl.replace(/\/completions\/?$/, '/');
    if (!finalBaseUrl.endsWith('/')) {
      finalBaseUrl += '/';
    }
    return {
      type: 'openai',
      baseUrl: finalBaseUrl,
      apiKey
    };
  }

  public getExecutionConfig(
    input: M | ModelProviderConfig<M>,
    options?: { openRouterSessionId?: string },
  ): ExecutionConfig {
    const model = this.getMappedModel(typeof input === 'object' && input !== null ? input.model : input);
    const providerType = this.getProviderType(input);

    const provider = this.getProviderConfig(providerType, model);
    if (provider && providerType === 'openrouter' && options?.openRouterSessionId) {
      provider.headers = { ...provider.headers, [OPENROUTER_SESSION_ID_HEADER]: options.openRouterSessionId };
    }
    return {
      model,
      providerType,
      provider
    };
  }

  static getProviderConfig(provider: ProviderType, modelName: string, apiKey: string): ProviderConfig | undefined {
    return new ProviderRegistry(apiKey).getProviderConfig(provider, modelName);
  }
}

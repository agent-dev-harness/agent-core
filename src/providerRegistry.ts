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

export interface ProviderRegistryConfig {
  tierModels: readonly string[];
  roleModels: readonly ModelProviderConfig[];
  allConfigs: readonly ModelProviderConfig[];
}

const EMPTY_KNOWN_MODELS: ProviderRegistryConfig = { tierModels: [], roleModels: [], allConfigs: [] };

export class ProviderRegistry {
  private apiKey: string | undefined;
  private readonly known: ProviderRegistryConfig;

  constructor(apiKey: string | undefined, knownModels?: ProviderRegistryConfig) {
    this.apiKey = apiKey;
    this.known = knownModels ?? EMPTY_KNOWN_MODELS;
  }

  public getMappedModel(modelName?: string): string {
    const tierModels = this.known.tierModels;
    if (!modelName) {
      const fallback = tierModels[0];
      if (!fallback) {
        throw new Error('ProviderRegistry: no model was given and no tierModels are configured to fall back on.');
      }
      return fallback;
    }
    const cleaned = modelName.replace('models/', '').trim();
    if (cleaned.includes('/')) {
      return cleaned;
    }

    const exact = tierModels.find(m => m === cleaned);
    if (exact) return exact;

    const partialCandidates = tierModels.filter(m => m.includes(cleaned) || cleaned.includes(m));
    if (partialCandidates.length > 0) {
      partialCandidates.sort((a, b) => b.length - a.length);
      return partialCandidates[0]!;
    }

    for (const role of this.known.roleModels) {
      if (role.model === cleaned || role.model.includes(cleaned)) {
        return role.model;
      }
    }

    return tierModels[0] || cleaned;
  }

  public getProviderType(input: string | ModelProviderConfig): ProviderType {
    if (typeof input === 'object' && input !== null) {
      return input.provider;
    }
    const model = this.getMappedModel(input as string);
    const allConfigs = this.known.allConfigs;

    let matchedConfig = allConfigs.find(t => t.model === model);

    if (!matchedConfig) {
      const candidates = allConfigs.filter(t => model.includes(t.model) || t.model.includes(model));
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.model.length - a.model.length);
        matchedConfig = candidates[0];
      }
    }

    return matchedConfig ? matchedConfig.provider : 'openrouter';
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
    input: string | ModelProviderConfig,
    options?: { openRouterSessionId?: string },
  ): ExecutionConfig {
    let providerType: ProviderType;
    let model: string;

    if (typeof input === 'object' && input !== null) {
      providerType = input.provider;
      model = this.getMappedModel(input.model);
    } else {
      model = this.getMappedModel(input as string);
      const allConfigs = this.known.allConfigs;

      let matchedConfig = allConfigs.find(t => t.model === model);

      if (!matchedConfig) {
        const candidates = allConfigs.filter(t => model.includes(t.model) || t.model.includes(model));
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.model.length - a.model.length);
          matchedConfig = candidates[0];
        }
      }

      providerType = matchedConfig ? matchedConfig.provider : 'openrouter';
    }

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

import { ModelProviderConfig, ProviderType } from './config/models';

export interface ProviderConfig {
  type: 'openai' | 'anthropic' | 'azure';
  baseUrl: string;
  apiKey?: string;
  wireApi?: 'completions' | 'responses';
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
      return tierModels[0] || 'gemini-3.1-flash-lite';
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

    return tierModels[0] || 'gemini-3.1-flash-lite';
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

    if (matchedConfig) {
      return matchedConfig.provider;
    } else if (model.includes('/')) {
      return 'openrouter';
    } else {
      return 'gemini';
    }
  }

  public getProviderConfig(provider: ProviderType, modelName: string): ProviderConfig | undefined {
    if (provider === 'copilot-native') {
      return undefined;
    }

    if (process.env.COPILOT_API_URL) {
      if (provider === 'openai' || process.env.VITEST === 'true') {
        return {
          type: 'openai',
          baseUrl: process.env.COPILOT_API_URL,
          apiKey: this.apiKey || 'mock-key'
        };
      }
    }

    if (provider === 'gemini') {
      if (!this.apiKey) {
        throw new Error('Missing API key for Gemini provider. Expected GEMINI_API_KEY to be set.');
      }
      return {
        type: 'openai',
        baseUrl: process.env.COPILOT_API_URL ? `${process.env.COPILOT_API_URL}/api/providers/gemini/v1beta/openai/` : `http://localhost:${process.env.PORT || 3000}/api/providers/gemini/v1beta/openai/`,
        apiKey: this.apiKey
      };
    } else if (provider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY || (this.apiKey !== 'mock-key' ? this.apiKey : undefined);
      if (!apiKey) {
        throw new Error('Missing API key for Anthropic provider. Expected ANTHROPIC_API_KEY to be set.');
      }
      return {
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1/',
        apiKey
      };
    } else if (provider === 'local') {
      return {
        type: 'openai',
        baseUrl: process.env.LOCAL_PROVIDER_URL || 'http://127.0.0.1:11434/v1/',
        apiKey: process.env.LOCAL_PROVIDER_API_KEY || 'ollama'
      };
    } else if (provider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY || (this.apiKey !== 'mock-key' ? this.apiKey : undefined);
      if (!apiKey) {
        throw new Error('Missing API key for OpenRouter provider. Expected OPENROUTER_API_KEY to be set.');
      }

      const proxyBaseUrl = process.env.COPILOT_API_URL ? `${process.env.COPILOT_API_URL}/api/providers/openrouter/api/v1/` : `http://localhost:${process.env.PORT || 3000}/api/providers/openrouter/api/v1/`;
      let finalBaseUrl = process.env.OPENROUTER_BASE_URL || proxyBaseUrl;
      if (finalBaseUrl) {
        finalBaseUrl = finalBaseUrl.trim();
        finalBaseUrl = finalBaseUrl.replace(/\/chat\/completions\/?$/, '/');
        finalBaseUrl = finalBaseUrl.replace(/\/completions\/?$/, '/');
        if (!finalBaseUrl.endsWith('/')) {
          finalBaseUrl += '/';
        }
      }
      return {
        type: 'openai',
        baseUrl: finalBaseUrl,
        apiKey
      };
    } else if (provider === 'openai') {
      if (process.env.COPILOT_API_URL) {
        return {
          type: 'openai',
          baseUrl: process.env.COPILOT_API_URL,
          apiKey: this.apiKey || 'mock-key'
        };
      }
      const apiKey = process.env.OPENAI_API_KEY || (this.apiKey !== 'mock-key' ? this.apiKey : undefined);
      if (!apiKey) {
        throw new Error('Missing API key for OpenAI provider. Expected OPENAI_API_KEY to be set.');
      }
      return {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1/',
        apiKey
      };
    }

    return undefined;
  }

  public getExecutionConfig(input: string | ModelProviderConfig): ExecutionConfig {
    let providerType: ProviderType = 'gemini';
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

      if (matchedConfig) {
        providerType = matchedConfig.provider;
      } else if (model.includes('/')) {
        providerType = 'openrouter';
      } else {
        providerType = 'gemini';
      }
    }

    const provider = this.getProviderConfig(providerType, model);
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

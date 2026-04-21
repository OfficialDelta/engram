import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export type EngramConfig = {
  llm: { apiKey?: string; pass1Model?: string; pass2Model?: string };
  embedding: { provider?: string; apiKey?: string; ollamaUrl?: string };
  consolidation: {
    turnThreshold?: number;
    eventThreshold?: number;
    windowSize?: number;
    windowOverlap?: number;
  };
  maintenance?: {
    decayThreshold?: number;
    decayFactor?: number;
  };
};

const MAINTENANCE_DEFAULTS = {
  decayThreshold: 0.05,
  decayFactor: 0.9,
};

const DEFAULTS: EngramConfig = {
  llm: {},
  embedding: {},
  consolidation: {},
};

export function getConfigPath(): string {
  return join(homedir(), '.engram', 'config.json');
}

export function loadConfig(overridePath?: string): EngramConfig {
  const filePath = overridePath ?? getConfigPath();
  let fileConfig: Partial<EngramConfig> = {};

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fileConfig = parsed as Partial<EngramConfig>;
    } else {
      process.stderr.write(`engram: config at ${filePath} is not a JSON object, using defaults\n`);
    }
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      // missing file is fine — silent
    } else {
      process.stderr.write(`engram: failed to read config at ${filePath}, using defaults\n`);
    }
  }

  const config: EngramConfig = {
    llm: { ...DEFAULTS.llm, ...fileConfig.llm },
    embedding: { ...DEFAULTS.embedding, ...fileConfig.embedding },
    consolidation: { ...DEFAULTS.consolidation, ...fileConfig.consolidation },
    ...(fileConfig.maintenance ? { maintenance: { ...fileConfig.maintenance } } : {}),
  };

  // Env var overrides (highest priority)
  if (process.env.ANTHROPIC_API_KEY) {
    config.llm.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.ENGRAM_EMBEDDING_PROVIDER) {
    config.embedding.provider = process.env.ENGRAM_EMBEDDING_PROVIDER;
  }

  const provider = config.embedding.provider ?? '';
  if (process.env.VOYAGE_API_KEY && provider.startsWith('voyage')) {
    config.embedding.apiKey = process.env.VOYAGE_API_KEY;
  }
  if (process.env.OPENAI_API_KEY && (provider === 'openai' || provider.startsWith('text-embedding'))) {
    config.embedding.apiKey = process.env.OPENAI_API_KEY;
  }

  return config;
}

export function saveConfig(config: EngramConfig, overridePath?: string): void {
  const filePath = overridePath ?? getConfigPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }
}

const KNOWN_PROVIDERS = ['voyage-3-lite', 'voyage-3', 'openai', 'text-embedding-3-small', 'text-embedding-3-large', 'local', 'ollama'];

export function validateConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['Config must be a plain object'] };
  }

  const c = config as Record<string, unknown>;

  if (c.embedding && typeof c.embedding === 'object') {
    const emb = c.embedding as Record<string, unknown>;
    if (emb.provider !== undefined && typeof emb.provider === 'string' && !KNOWN_PROVIDERS.includes(emb.provider)) {
      errors.push(`Unknown embedding provider "${emb.provider}". Known: ${KNOWN_PROVIDERS.join(', ')}`);
    }
  }

  if (c.consolidation && typeof c.consolidation === 'object') {
    const con = c.consolidation as Record<string, unknown>;
    for (const key of ['turnThreshold', 'eventThreshold', 'windowSize', 'windowOverlap'] as const) {
      if (con[key] !== undefined) {
        if (typeof con[key] !== 'number' || con[key] <= 0) {
          errors.push(`consolidation.${key} must be a positive number`);
        }
      }
    }
  }

  if (c.maintenance && typeof c.maintenance === 'object') {
    const maint = c.maintenance as Record<string, unknown>;
    for (const key of ['decayThreshold', 'decayFactor'] as const) {
      if (maint[key] !== undefined) {
        if (typeof maint[key] !== 'number' || maint[key] <= 0) {
          errors.push(`maintenance.${key} must be a positive number`);
        }
      }
    }
    if (typeof maint.decayThreshold === 'number' && maint.decayThreshold >= 1) {
      errors.push('maintenance.decayThreshold must be less than 1');
    }
    if (typeof maint.decayFactor === 'number' && maint.decayFactor >= 1) {
      errors.push('maintenance.decayFactor must be less than 1');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function getMaintenanceConfig(config: EngramConfig): { decayThreshold: number; decayFactor: number } {
  return {
    decayThreshold: config.maintenance?.decayThreshold ?? MAINTENANCE_DEFAULTS.decayThreshold,
    decayFactor: config.maintenance?.decayFactor ?? MAINTENANCE_DEFAULTS.decayFactor,
  };
}

export function maskApiKey(key: string): string {
  if (key.length <= 4) return '****';
  return '****' + key.slice(-4);
}

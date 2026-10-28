import { isDirectoryEdition } from '../edition';
import { emitTelemetryInfo, emitTelemetryWarning } from './telemetry';
import { applyOfflineTransformersEnv, type TransformersEnv } from './transformers-offline-env';

// s77-m03: the GPT encoder path + the boot-time preload/health apparatus
// (ensureTokenizersReady / getTokenizerHealth / recordTokenizerFallback / the
// per-model status snapshot) were excised. What remains is the honest lazy loader
// for the Claude (@xenova) tokenizer; Gemini stays a heuristic (no loader), and an
// unsupported model throws in TokenCounter.count.

type ClaudeTokenizer = (text: string) => Promise<{
  input_ids: { data: { length: number } };
}>;

type ClaudeModule = {
  AutoTokenizer?: { from_pretrained?: (...args: unknown[]) => unknown };
  default?: { AutoTokenizer?: { from_pretrained?: (...args: unknown[]) => unknown } };
};

type ModuleLoader<T> = () => Promise<T>;

const SOURCE = 'tokenizer-bootstrap';

let claudeTokenizer: ClaudeTokenizer | null = null;
let claudeLoadPromise: Promise<ClaudeTokenizer | null> | null = null;
let claudeModuleLoader: ModuleLoader<ClaudeModule> | null = null;
// Negative cache (Sprint 78 m03): once a load fails, stop re-attempting the HF fetch
// for the rest of the process — the counter is a test-observable "attempted once" proof.
let claudeLoadFailed = false;
let claudeLoadAttempts = 0;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function loadClaudeTokenizer(): Promise<ClaudeTokenizer | null> {
  if (isDirectoryEdition()) return null;
  if (claudeTokenizer) {
    return claudeTokenizer;
  }
  // Negative cache (s78-m03): after a failed load, fall back to the heuristic count
  // WITHOUT re-hitting HuggingFace on every call (a per-call network timeout offline).
  if (claudeLoadFailed) {
    return null;
  }

  if (!claudeLoadPromise) {
    claudeLoadPromise = (async () => {
      claudeLoadAttempts += 1;
      try {
        const module = await (claudeModuleLoader
          ? claudeModuleLoader()
          : (import('@xenova/transformers') as Promise<ClaudeModule>));
        // Local-forever hook (s78-m03): honor RBOOK_OFFLINE_EMBEDDINGS / RBOOK_MODEL_CACHE_DIR
        // before from_pretrained so an offline install fails fast into the negative cache.
        const env =
          (module as { env?: TransformersEnv }).env ??
          (module as { default?: { env?: TransformersEnv } }).default?.env;
        if (env) {
          applyOfflineTransformersEnv(env);
        }
        const autoTokenizer = module.AutoTokenizer ?? module.default?.AutoTokenizer;

        if (!autoTokenizer || typeof autoTokenizer.from_pretrained !== 'function') {
          throw new Error('AutoTokenizer.from_pretrained is not available');
        }

        const tokenizer = (await autoTokenizer.from_pretrained(
          'Xenova/claude-tokenizer'
        )) as ClaudeTokenizer;
        claudeTokenizer = tokenizer;
        emitTelemetryInfo(SOURCE, 'Claude tokenizer loaded', {});
        return tokenizer;
      } catch (error) {
        claudeTokenizer = null;
        claudeLoadFailed = true;
        emitTelemetryWarning(SOURCE, 'Failed to load Claude tokenizer', {
          error: errorMessage(error),
        });
        return null;
      }
    })().finally(() => {
      claudeLoadPromise = null;
    });
  }

  return claudeLoadPromise;
}

export async function getClaudeTokenizerInstance(): Promise<ClaudeTokenizer | null> {
  const tokenizerInstance = await loadClaudeTokenizer();
  return tokenizerInstance ?? null;
}

export const __test__ = {
  reset(): void {
    claudeTokenizer = null;
    claudeLoadPromise = null;
    claudeModuleLoader = null;
    claudeLoadFailed = false;
    claudeLoadAttempts = 0;
  },
  setModuleLoaders(loaders: { claude?: ModuleLoader<ClaudeModule> | null }): void {
    if (typeof loaders.claude !== 'undefined') {
      claudeModuleLoader = loaders.claude;
      claudeTokenizer = null;
      claudeLoadPromise = null;
      claudeLoadFailed = false;
      claudeLoadAttempts = 0;
    }
  },
  getState(): { claudeLoaded: boolean; claudeLoadFailed: boolean; claudeLoadAttempts: number } {
    return {
      claudeLoaded: claudeTokenizer !== null,
      claudeLoadFailed,
      claudeLoadAttempts,
    };
  },
};

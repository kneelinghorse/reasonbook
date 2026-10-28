/**
 * Token Counters - Hybrid Offline Strategy
 *
 * Model-specific token counting implementations using offline libraries.
 * s77-m03 excised the GPT path (gpt-tokenizer removed); the honest surface is:
 * - Claude: Transformers.js with Xenova/claude-tokenizer (known drift, monitored)
 * - Gemini: Enhanced heuristic (temporary, pending official library)
 * An unsupported model (e.g. the retired 'gpt') throws `Unsupported model: …`.
 */

import { isDirectoryEdition } from '../edition';
import { AbortableOptions, ITokenCounter, TokenCount, SupportedModel } from './types';
import { emitTelemetryWarning } from './telemetry';
import { getClaudeTokenizerInstance } from './tokenizer-bootstrap';
import { throwIfAborted, withAbort } from '../utils/abort';

/**
 * Type definitions for external libraries
 */
type ClaudeTokenizer = (text: string) => Promise<{
  input_ids: { data: { length: number } };
}>;

/**
 * Token counter implementation using TokenizerFactory pattern
 */
export class TokenCounter implements ITokenCounter {
  private static claudeTokenizerCache: ClaudeTokenizer | null = null;

  /**
   * Count tokens for a given text and model
   * Factory method that routes to the appropriate tokenizer implementation
   */
  async count(
    text: string,
    model: SupportedModel,
    options: AbortableOptions = {}
  ): Promise<TokenCount> {
    const { signal } = options;
    throwIfAborted(signal, 'Token counting aborted');

    switch (model) {
      case 'claude':
        return this.countClaude(text, options);
      case 'gemini':
        return this.countGemini(text, options);
      default:
        throw new Error(`Unsupported model: ${model}`);
    }
  }

  /**
   * Count tokens for Claude using Transformers.js with Xenova/claude-tokenizer
   * WARNING: This is an unofficial tokenizer with documented accuracy drift
   * Token counts may differ from official Anthropic API by up to 50%+
   * Should be monitored via validation suite in B2.3
   */
  private async countClaude(text: string, options: AbortableOptions): Promise<TokenCount> {
    if (isDirectoryEdition()) return this.fallbackCount(text, 'claude', options.signal);
    const { signal } = options;

    try {
      let tokenizer = TokenCounter.claudeTokenizerCache;

      if (!tokenizer) {
        tokenizer = await withAbort(
          getClaudeTokenizerInstance(),
          signal,
          'Loading Claude tokenizer aborted'
        );
        if (!tokenizer) {
          return this.fallbackCount(text, 'claude', signal);
        }
        TokenCounter.claudeTokenizerCache = tokenizer;
      }

      if (!tokenizer) {
        return this.fallbackCount(text, 'claude', signal);
      }

      throwIfAborted(signal, 'Token counting aborted');

      // Tokenize the text
      const encoded = await withAbort(tokenizer(text), signal, 'Claude tokenization aborted');
      throwIfAborted(signal, 'Token counting aborted');
      const count = encoded.input_ids.data.length;

      // Emit telemetry warning about potential drift
      emitTelemetryWarning(
        'token-counter',
        'Claude token count using unofficial tokenizer (Transformers.js)',
        {
          tokenizer: 'Xenova/claude-tokenizer',
          textLength: text.length,
          estimatedTokens: count,
          accuracyNote:
            'May drift up to 50% from official Anthropic API. Weekly validation recommended.',
        }
      );

      return {
        model: 'claude',
        count,
        estimatedCost: this.estimateClaudeCost(count),
      };
    } catch (_error) {
      TokenCounter.claudeTokenizerCache = null;
      // Fallback to heuristic if tokenizer fails to load
      return this.fallbackCount(text, 'claude', signal);
    }
  }

  /**
   * Count tokens for Gemini using enhanced heuristic
   * TEMPORARY SOLUTION: No viable offline library exists
   * - @lenml/tokenizer-gemini is 139 MB (unacceptable)
   * - Official JS library does not exist
   * Uses conservative overestimation (1.5x safety margin) to prevent context overflow
   */
  private async countGemini(text: string, options: AbortableOptions): Promise<TokenCount> {
    const { signal } = options;
    throwIfAborted(signal, 'Token counting aborted');

    // Enhanced heuristic: base estimate with 50% safety margin
    const baseTokens = Math.ceil(text.length / 4);
    const count = Math.ceil(baseTokens * 1.5);

    emitTelemetryWarning('token-counter', 'Gemini heuristic token estimate applied', {
      textLength: text.length,
      baseTokens,
      safetyFactor: 1.5,
      estimatedTokens: count,
    });

    return {
      model: 'gemini',
      count,
      estimatedCost: this.estimateGeminiCost(count),
    };
  }

  /**
   * Fallback token counting using basic heuristic
   * Approximately 4 characters per token for English text
   * Used when primary tokenizer fails to load
   */
  private fallbackCount(text: string, model: SupportedModel, signal?: AbortSignal): TokenCount {
    throwIfAborted(signal, 'Token counting aborted');

    const count = Math.ceil(text.length / 4);

    emitTelemetryWarning('token-counter', `Fallback heuristic used for ${model} tokenizer`, {
      model,
      textLength: text.length,
      estimatedTokens: count,
      reason: 'Primary tokenizer failed to load',
      accuracyNote: 'Basic heuristic (4 chars/token) - accuracy may vary significantly',
    });

    let estimatedCost: number | undefined;
    switch (model) {
      case 'claude':
        TokenCounter.claudeTokenizerCache = null;
        estimatedCost = this.estimateClaudeCost(count);
        break;
      case 'gemini':
        estimatedCost = this.estimateGeminiCost(count);
        break;
    }

    return {
      model,
      count,
      estimatedCost,
    };
  }

  /**
   * Estimate cost for Claude tokens (input pricing)
   * Claude 3.5 Sonnet: ~$3.00 per 1M input tokens
   */
  private estimateClaudeCost(tokens: number): number {
    return (tokens / 1_000_000) * 3.0;
  }

  /**
   * Estimate cost for Gemini tokens (input pricing)
   * Gemini 1.5 Pro: ~$1.25 per 1M input tokens
   */
  private estimateGeminiCost(tokens: number): number {
    return (tokens / 1_000_000) * 1.25;
  }
}

/**
 * Export singleton instance for default usage
 * No API keys required - fully offline operation
 */
export const defaultTokenCounter = new TokenCounter();

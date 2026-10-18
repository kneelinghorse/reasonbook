// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Pending drafts are offered and bound first (s93-m06); then the first eligible prompt recalls five
// ABOUTME: decision previews and later prompts three unseen matches, all inside the hook's time and text budgets.

import type { HookDelivery, HookVerbContext } from '../cli';
import {
  frameForeignInline,
  isForeignProject,
  provenanceTag,
} from '../intelligence/provenance-frame';
import { recallFirstPrompt, type RecallResult } from '../tools/rbook/first-prompt-recall';
import type { RenderedContext } from '../tools/rbook/rendered-context';
import { previewText } from '../tools/rbook/text-preview';
import { conflictMark, CONFLICT_POINTER } from '../tools/rbook/record-conflict-marks';
import { CliStoreError, hookStore, HOOK_CAPS } from './core';
import { captureToolCall } from '../tools/rbook/tool-call-context';
import { deliverPromptRecall } from './recall-runtime';
import { recallLaterPrompt, skipLaterPrompt } from './later-prompt-recall';
import type { PreparedOffer } from './drafts-hook';
import { observeDrafts } from './telemetry';

/** The recalled decisions within the cap, their conflict marks naming a field where that fits. */
export function renderFirstPrompt(
  result: RecallResult,
  cap: number = HOOK_CAPS.prompt!
): RenderedContext {
  const marked = renderRecall(result, cap, false);
  // s96-m12: at the smallest room the hook gives recall, five marks naming their fields do not fit.
  return marked.text.length <= cap ? marked : renderRecall(result, cap, true);
}

/** Keep all selected IDs: divide the available preview space instead of chopping off item five. */
function renderRecall(result: RecallResult, cap: number, bareMarks: boolean): RenderedContext {
  const items = result.items.slice(0, 5);
  if (!items.length) return { text: '', returnedIds: [], items: [] };
  const header = 'Relevant decisions:\n';
  // s96-m12: a decision in conflict on a shared record is marked, and the pointer says how to settle it.
  const conflicted = items.some((item) => item.conflicts?.length);
  const pointer = `\nRead with rbook_decisions(action="show", decisionId=N).${conflicted ? ` ${CONFLICT_POINTER}` : ''}`;
  const perItem = Math.floor(
    (cap - header.length - pointer.length - (items.length - 1)) / items.length
  );
  let text = header;
  const spans: Array<{ typedId: string; start: number; end: number }> = [];
  const returnedIds: string[] = [];
  for (const item of items) {
    if (spans.length) text += '\n';
    const typedId = `d:${item.id}`;
    const prefix = `  • ${typedId} ${conflictMark(item.conflicts, bareMarks)}`;
    const foreign = isForeignProject(item.projectId, result.localProjectId);
    const source = provenanceTag(item.projectId);
    const framing = foreign ? frameForeignInline('', source).length : 0;
    const preview = previewText(item.text, Math.max(1, perItem - prefix.length - framing)).preview;
    const line = prefix + (foreign ? frameForeignInline(preview, source) : preview);
    const start = text.length;
    text += line;
    spans.push({ typedId, start, end: text.length });
    if (!foreign) returnedIds.push(typedId);
  }
  return { text: text + pointer, returnedIds, items: spans };
}

/** Recall is skipped, and not consumed, when the offers leave it less room than this (B16). */
export const MIN_RECALL_ROOM = 300;

/** The offers, then the recall context, with the recall's spans moved past the offers. */
function afterOffers(offers: string, context: RenderedContext): RenderedContext {
  const shift = offers.length + 2;
  return {
    text: `${offers}\n\n${context.text}`,
    returnedIds: context.returnedIds,
    items: context.items.map((item) => ({
      ...item,
      start: item.start + shift,
      end: item.end + shift,
    })),
  };
}

/**
 * Telemetry and ambient checks already ran. Drafts come first, before any skip rule (the design's
 * critic 1, N6): an "approved" is exactly the short reply the later-prompt skip drops. No nonempty
 * prompt means no first-attempt claim.
 */
export async function run(ctx: HookVerbContext): Promise<string | HookDelivery | null> {
  const query = ctx.input.prompt?.trim();
  const rawSessionId = ctx.input.session_id?.trim();
  if (!query || !rawSessionId) return null;
  const store = hookStore(ctx.resolution);
  if (!store) return null;
  const deadlineAtMs = ctx.deadlineAtMs ?? Date.now() + 800;
  const drafts = await import('./drafts-hook');
  let offer: PreparedOffer = drafts.NO_OFFER;
  try {
    // The prompt hook runs as a read; its draft step writes (a decline, a first-offer time) to the
    // carve-out proposals table, so it is classified as the write it is (the plan critic, N8).
    offer = (
      await captureToolCall('write', async () =>
        drafts.prepareOffer({
          dbPath: store.dbPath,
          rawSessionId,
          message: ctx.input.prompt ?? '',
          env: ctx.io.env,
          deadlineAtMs,
        })
      )
    ).value;
  } catch (error) {
    // Drafts that cannot be read must not take recall down with them; the hook's one stderr line
    // says so (it is held and printed once, after the output).
    process.stderr.write(
      `drafts unavailable: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
  observeDrafts(ctx.io, {
    draftsOffered: offer.offered,
    ...(offer.reply ? { draftReply: offer.reply } : {}),
  });
  const offers = offer.text;
  const room = HOOK_CAPS.prompt! - (offers ? offers.length + 2 : 0);
  return {
    deliver: async (emit) => {
      let emitted = false;
      const emitRecall = (context: RenderedContext): string => {
        emitted = true;
        if (!offers) return emit(context);
        // The recall runtime matches its spans against the recall text: hand back that part only.
        return emit(afterOffers(offers, context)).slice(offers.length + 2);
      };
      try {
        deliverPromptRecall(
          { dbPath: store.dbPath, rawSessionId, env: ctx.io.env, deadlineAtMs },
          (first, seen) => {
            if (!first && skipLaterPrompt(query)) return null;
            if (room < MIN_RECALL_ROOM) return null;
            const result = first
              ? recallFirstPrompt(store.dbPath, query, { deadlineAtMs })
              : recallLaterPrompt(store.dbPath, query, seen, { deadlineAtMs });
            if (!result.available)
              throw new CliStoreError(
                result.warnings.join('; ') || 'first-prompt recall unavailable'
              );
            return renderFirstPrompt(result, room);
          },
          emitRecall
        );
      } catch (error) {
        // A failed recall must not swallow the offer: the operator's answer depends on it.
        if (!offers || emitted) throw error;
      }
      if (offers && !emitted) emit(offers);
      if (offers) await captureToolCall('write', async () => offer.commit());
    },
  };
}

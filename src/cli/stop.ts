// SPDX-License-Identifier: Apache-2.0
// ABOUTME: `hook stop`: never writes stdout (Claude Code charges a turn for Stop output, #1187). s93-m06 fills it:
// ABOUTME: the reply's trailing "Would record" lines become drafts, silently. Loads better-sqlite3 and its modules.

import type { HookVerbContext } from '../cli';
import { hookStore } from './core';
import { observeDrafts } from './telemetry';

export async function run(ctx: HookVerbContext): Promise<null> {
  const rawSessionId = ctx.input.session_id?.trim();
  if (!rawSessionId) return null;
  const store = hookStore(ctx.resolution);
  if (!store) return null;
  const { onStop } = await import('./drafts-hook');
  const outcome = onStop({
    dbPath: store.dbPath,
    rawSessionId,
    reply: ctx.input.last_assistant_message,
    transcriptPath: ctx.input.transcript_path,
    env: ctx.io.env,
    deadlineAtMs: ctx.deadlineAtMs ?? Date.now() + 500,
  });
  observeDrafts(ctx.io, {
    draftLines: outcome.lines,
    draftsCreated: outcome.created,
    draftsReplaced: outcome.replaced,
    draftLinesElsewhere: outcome.elsewhere,
    draftLinesDropped: outcome.dropped,
  });
  return null;
}

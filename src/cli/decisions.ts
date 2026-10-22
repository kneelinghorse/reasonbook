// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Record shaped decisions from the CLI through the same validated MCP handler.
// ABOUTME: Require the existing harness owner and parse arrays without inventing approval evidence.

import type { CliIo } from './core';
import { NO_SESSION_REMEDY } from './commands';
import { observeCliResult } from './telemetry';
import { captureToolCall } from '../tools/rbook/tool-call-context';
import { setExternalSessionOwner } from '../tools/rbook/session-owner';
import {
  rbookDecisions,
  rbookDecisionsSchema,
  formatDecisionsForLLM,
} from '../tools/rbook/rbook-decisions';
import type { RbookDecisionsParams } from '../tools/rbook/rbook-decisions';
import { validateRbookArguments } from '../tools/rbook/tool-validation';

export async function decisions(
  projectRoot: string,
  positional: readonly string[],
  flags: Readonly<Record<string, string>>,
  io: CliIo
): Promise<number> {
  if (positional[0] !== 'record') {
    io.stderr('reasonbook decisions: use record --session-id <id> --content <headline>.');
    return 1;
  }
  if (!flags['session-id'] || flags['session-id'] === 'true') {
    io.stderr(`reasonbook decisions record: ${NO_SESSION_REMEDY}.`);
    return 1;
  }
  if (!flags.content || flags.content === 'true') {
    io.stderr('reasonbook decisions record: pass --content <headline>.');
    return 1;
  }
  const args: Record<string, unknown> = { action: 'record', content: flags.content, projectRoot };
  for (const name of ['context', 'consequences', 'mode', 'domain'] as const) {
    if (flags[name] !== undefined) args[name] = flags[name];
  }
  for (const name of ['alternatives', 'deciders'] as const) {
    if (flags[name] === undefined) continue;
    try {
      args[name] = JSON.parse(flags[name]);
    } catch {
      io.stderr(`reasonbook decisions record: --${name} must be a JSON array of strings.`);
      return 1;
    }
  }
  if (flags.mission) args.missionId = flags.mission;
  if (flags.sprint) args.sprintId = flags.sprint;
  const checked = validateRbookArguments(rbookDecisionsSchema, args);
  if (!checked.success) {
    observeCliResult(io, 'rbook_decisions', args, checked);
    if (flags.format === 'json') io.stdout(`${JSON.stringify(checked)}\n`);
    else
      io.stderr(
        `reasonbook decisions record: ${checked.error!.message}. ${checked.error!.suggestion ?? ''}`
      );
    return 1;
  }
  setExternalSessionOwner(flags['session-id']);
  const result = await captureToolCall('write', () =>
    rbookDecisions(checked.data! as RbookDecisionsParams)
  );
  observeCliResult(io, 'rbook_decisions', args, result.value);
  io.stdout(
    `${flags.format === 'json' ? JSON.stringify(result.value) : formatDecisionsForLLM('record', result.value)}\n`
  );
  return result.value.success ? 0 : 1;
}

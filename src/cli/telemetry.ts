// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Collects one local measurement for each CLI invocation, including silent and failed hooks.
// ABOUTME: Prompt rules are read without migrations; only typed IDs, hashes and counts reach the log.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as path from 'path';

import { rbookConfigDir, harnessSessionHash } from '../tools/rbook/harness-session';
import {
  appendTelemetry,
  targetForStore,
  type TelemetryRecord,
  type TelemetryTarget,
} from '../tools/rbook/local-telemetry';
import { matchPrompt } from '../tools/rbook/prompt-patterns';
import { restatedRuleIds, type RuleInForce } from '../tools/rbook/restatement';
import { returnedIds, usedIds } from '../tools/rbook/telemetry-extract';
import type { RenderedContext } from '../tools/rbook/rendered-context';
import {
  parseArgs,
  resolveCliProject,
  type CliIo,
  type CliResolution,
  type HookInput,
} from './core';

const collectors = new WeakMap<CliIo, CliTelemetry>();

/** No migrations, table creation, or cached rules: each prompt sees the rules then in force. */
export function rulesInForce(dbPath: string, now = new Date()): RuleInForce[] {
  const projectId = targetForStore(dbPath)?.projectId ?? null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 50');
    const constraintColumns = db.pragma('table_info(constraints)') as Array<{ name: string }>;
    const scopedConstraints = constraintColumns.some((column) => column.name === 'project_id');
    if (scopedConstraints && projectId === null)
      throw new Error('Project identity is unavailable.');
    const constraints = db
      .prepare(
        `SELECT id, content FROM constraints WHERE status = 'active'
       AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))
       ${scopedConstraints ? 'AND (project_id IS NULL OR project_id = ?)' : ''} ORDER BY id`
      )
      .all(now.toISOString(), ...(scopedConstraints ? [projectId] : [])) as Array<{
      id: number;
      content: string;
    }>;
    const columns = db.pragma('table_info(learnings)') as Array<{ name: string }>;
    if (columns.length === 0) throw new Error('The learnings table is absent.');
    const scopedLearnings = columns.some((column) => column.name === 'project_id');
    if (scopedLearnings && projectId === null) throw new Error('Project identity is unavailable.');
    // A store from before evergreen has no flagged learnings. Reading must not migrate it.
    const learnings = columns.some((column) => column.name === 'evergreen')
      ? (db
          .prepare(
            `SELECT id, content FROM learnings WHERE status = 'active' AND evergreen = 1
             ${scopedLearnings ? 'AND (project_id IS NULL OR project_id = ?)' : ''} ORDER BY id`
          )
          .all(...(scopedLearnings ? [projectId] : [])) as Array<{ id: number; content: string }>)
      : [];
    return [
      ...constraints.map((row) => ({ id: `c:${row.id}`, content: row.content })),
      ...learnings.map((row) => ({ id: `l:${row.id}`, content: row.content })),
    ];
  } finally {
    db.close();
  }
}

/** The digest uses #N for both kinds; section plus structured IDs supplies the missing type. */
function injectedDigestIds(text: string, returned: readonly string[]): string[] {
  const allowed = new Set(returned);
  const ids: string[] = [];
  let prefix: 'd' | 'l' | null = null;
  for (const line of text.split('\n')) {
    if (line === 'Recent decisions:') {
      prefix = 'd';
      continue;
    }
    if (line === 'Recent learnings:') {
      prefix = 'l';
      continue;
    }
    if (!line.startsWith('  • ')) {
      prefix = null;
      continue;
    }
    const match = /^ {2}• #([1-9]\d*) /.exec(line);
    const id = prefix && match ? `${prefix}:${match[1]}` : null;
    if (id && allowed.has(id)) ids.push(id);
  }
  return [...new Set(ids)];
}

/** A complete owned item span must survive the final cap; record prose cannot invent an ID. */
export function emittedRenderedIds(context: RenderedContext, emitted: string): string[] {
  const allowed = new Set(context.returnedIds);
  return [
    ...new Set(
      context.items
        .filter((item) => {
          const source = context.text.slice(item.start, item.end);
          return (
            allowed.has(item.typedId) &&
            /^[dlcn]:[1-9]\d*$/.test(item.typedId) &&
            item.start >= 0 &&
            item.end > item.start &&
            item.end <= emitted.length &&
            (item.start === 0 || context.text[item.start - 1] === '\n') &&
            source.startsWith(`  • ${item.typedId} `) &&
            emitted.slice(item.start, item.end) === source
          );
        })
        .map((item) => item.typedId)
    ),
  ];
}

/** Mutable only until finish: an abandoned hook cannot append again or alter its receipt. */
export class CliTelemetry {
  private record: TelemetryRecord;
  private target: TelemetryTarget;
  private resolution: CliResolution | null = null;
  private finished = false;
  private rendered: RenderedContext | null = null;

  constructor(
    private readonly io: CliIo,
    verb: string,
    argv: readonly string[],
    hook = false
  ) {
    const { flags, positional } = parseArgs(argv);
    const action = ['session', 'ambient', 'profile', 'drafts'].includes(verb)
      ? (positional[0] ?? null)
      : null;
    const mode =
      ['review', 'relevant', 'profile', 'stats', 'drafts'].includes(verb) ||
      (verb === 'feedback' && flags['dry-run'] === 'true') ||
      (verb === 'ambient' && action === null)
        ? 'read'
        : ['capture', 'feedback', 'session', 'ambient', 'init'].includes(verb)
          ? 'write'
          : null;
    this.record = {
      ts: new Date().toISOString(),
      session:
        flags['session-id'] && flags['session-id'] !== 'true'
          ? `ext:${harnessSessionHash(flags['session-id'])}`
          : null,
      surface: hook ? 'hook' : 'cli',
      client:
        hook && flags.harness && flags.harness !== 'claude'
          ? flags.harness
          : hook && flags.format !== 'text'
            ? 'claude-code'
            : null,
      tool: hook ? `hook ${verb}` : verb,
      action,
      mode,
      ok: false,
      refused: null,
      failOpen: null,
      ambient: null,
      ...(hook ? { charsInjected: 0, idsInjected: [] } : {}),
    };
    this.target = {
      projectId: 'unattributed',
      dbPath: path.join(rbookConfigDir(io.env), 'unattributed.sqlite'),
    };
    this.resolve(
      resolveCliProject({ projectRootArg: flags['project-root'], env: io.env, cwd: io.cwd })
    );
    collectors.set(io, this);
  }

  patch(fields: Partial<TelemetryRecord>): void {
    if (!this.finished) this.record = { ...this.record, ...fields };
  }

  resolve(resolution: CliResolution): void {
    if (this.finished) return;
    this.resolution = resolution;
    const unattributed = {
      projectId: 'unattributed',
      dbPath: path.join(rbookConfigDir(this.io.env), 'unattributed.sqlite'),
    };
    this.target =
      resolution.kind === 'store'
        ? (targetForStore(resolution.dbPath) ?? unattributed)
        : unattributed;
  }

  /** Returns whether the rule query failed; the hook owns its one-line diagnostic. */
  prompt(input: HookInput): boolean {
    if (this.finished) return false;
    this.patch({
      session: input.session_id?.trim() ? `ext:${harnessSessionHash(input.session_id)}` : null,
    });
    const source = input.source;
    if (
      this.record.tool === 'hook session-start' &&
      (source === 'startup' || source === 'resume' || source === 'clear' || source === 'compact')
    )
      this.patch({ source });
    if (this.record.tool !== 'hook prompt') return false;
    this.patch({ ...matchPrompt(input.prompt ?? ''), restatedRuleIds: [] });
    if (this.resolution?.kind !== 'store') return false;
    try {
      this.patch({
        restatedRuleIds: restatedRuleIds(input.prompt ?? '', rulesInForce(this.resolution.dbPath)),
      });
      return false;
    } catch {
      this.patch({ ruleReadFailed: true });
      return true;
    }
  }

  result(
    tool: string,
    args: unknown,
    result: { success: boolean; data?: unknown; error?: { code: string } }
  ): void {
    this.patch({
      idsReturned: returnedIds(tool, args, result.data),
      idsCited: usedIds(tool, args, this.record.mode, result),
      ...(result.error ? { refused: result.error.code } : {}),
    });
  }

  injected(text: string): void {
    this.patch({
      charsInjected: text.length,
      digestHash: createHash('sha256').update(text).digest('hex'),
      idsInjected: this.rendered
        ? emittedRenderedIds(this.rendered, text)
        : injectedDigestIds(text, this.record.idsReturned ?? []),
    });
  }

  deliveredContext(): RenderedContext | undefined {
    return this.rendered ?? undefined;
  }

  renderedContext(context: RenderedContext): void {
    if (this.finished) return;
    this.rendered = context;
    this.patch({ idsReturned: context.returnedIds });
  }

  finish(code: number): void {
    if (this.finished) return;
    this.patch({
      ok: code === 0 && this.record.failOpen === null,
      refused: this.record.refused ?? (code === 0 ? null : 'CLI_REFUSED'),
    });
    this.finished = true;
    collectors.delete(this.io);
    appendTelemetry(this.record, this.target, this.io.env);
  }
}

/** Observers do nothing outside a measured dispatch (direct callers retain their prior behavior). */
export function observeCliResult(
  io: CliIo | undefined,
  tool: string,
  args: unknown,
  result: {
    success: boolean;
    data?: unknown;
    error?: { code: string };
  }
): void {
  if (io) collectors.get(io)?.result(tool, args, result);
}

/** Relevant displays pulled rows too; only local or legacy rows have locally meaningful IDs. */
export function observeRelevantIds(
  io: CliIo,
  dbPath: string,
  items: readonly { kind: 'decision' | 'learning'; id: number }[]
): void {
  const collector = collectors.get(io);
  if (!collector) return;
  const projectId = targetForStore(dbPath)?.projectId;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 50 });
    const local = new Set<string>();
    for (const [kind, table, prefix] of [
      ['decision', 'strategic_decisions', 'd'],
      ['learning', 'learnings', 'l'],
    ] as const) {
      const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      const scoped = columns.some((column) => column.name === 'project_id');
      if (scoped && projectId === undefined) continue;
      const query = db.prepare(
        `SELECT id FROM ${table} WHERE id = ? ${
          scoped ? 'AND (project_id IS NULL OR project_id = ?)' : ''
        }`
      );
      for (const item of items.filter((item) => item.kind === kind)) {
        if (query.get(item.id, ...(scoped ? [projectId] : []))) local.add(`${prefix}:${item.id}`);
      }
    }
    collector.patch({
      idsReturned: items
        .map((item) => `${item.kind === 'decision' ? 'd' : 'l'}:${item.id}`)
        .filter((id) => local.has(id)),
    });
  } catch {
    // An unavailable measurement must not change a successful search or invent local IDs.
    collector.patch({ idsReturned: [] });
  } finally {
    db?.close();
  }
}

/** s93-m06: draft counts and the reply class, never draft text or the operator's message. */
export function observeDrafts(
  io: CliIo,
  fields: Pick<
    TelemetryRecord,
    | 'draftLines'
    | 'draftsCreated'
    | 'draftsReplaced'
    | 'draftLinesElsewhere'
    | 'draftsOffered'
    | 'draftReply'
  >
): void {
  collectors.get(io)?.patch(fields);
}

export function observeInjected(io: CliIo, text: string): void {
  collectors.get(io)?.injected(text);
}

/** Register trusted render metadata; the actual output call decides which spans were delivered. */
export function observeRenderedContext(io: CliIo | undefined, context: RenderedContext): void {
  if (io) collectors.get(io)?.renderedContext(context);
}

/** The renderer-owned spans for a prepared digest, without guessing IDs from prose. */
export function preparedRenderedContext(io: CliIo): RenderedContext | undefined {
  return collectors.get(io)?.deliveredContext();
}

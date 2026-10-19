// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — reads a harness transcript, its subagents' included, for outside content, and for the last reply
// ABOUTME: when Stop carries none. Line-aligned bounded reads under a deadline; raw paths are never stored.

import { toolNameSuffix } from '../intelligence/legacy-compat';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * WHY (design doc s93 m06 fork 7; build plan B13, folded with plan critic B4). A draft proposed
 * after the session read a web page, or another project's records, may carry words neither the
 * operator nor the agent wrote. The offer says so. The predicate, published:
 *   - a tool call named WebFetch or WebSearch; an `mcp__` tool whose name says fetch, scrape,
 *     crawl, browse or search_engine; a browser tool (Claude in Chrome, the built-in browser);
 *   - a Bash command running curl, wget, or `gh api|issue|pr|release|repo`;
 *   - a Reasonbook call with `"acrossProjects": true`, and any `rbook_message` call;
 *   - an MCP tool result carrying a Reasonbook provenance fence (`[UNTRUSTED DATA` or `⟪untrusted`).
 *     Fences count only in MCP results (the transcript marks them with `mcpMeta`), so reading
 *     Reasonbook's own source code, which contains the fence text, does not flag a session.
 * Subagents write their own transcripts (`<session>/subagents/*.jsonl`), where most web research
 * runs; each is scanned too. A session that called a subagent whose transcript is absent reads
 * unknown.
 *
 * FALSE NEGATIVES, NAMED. Fetches through other tools (a script, python's requests, `git clone`),
 * content tools whose names say none of the words above (research or article servers), and
 * results stored outside the transcript. Unknown (null) is reported for anything not read: a
 * transcript or subagent file that could not be read, bytes skipped past the per-call budget, and
 * a scan cut short by the hook's deadline. Unknown is never reported as "none".
 */

/** At most this many new bytes are read per Stop, across all of a session's files. */
export const SCAN_MAX_BYTES = 4 * 1024 * 1024;

const WEB_TOOL = /^(?:WebFetch|WebSearch)$/;
const MCP_FETCH = /^mcp__.*(?:fetch|scrape|crawl|browse|search_engine)/i;
const BROWSER = /^mcp__(?:claude-in-chrome|Claude_Browser|remote-devices__Claude_Browser)__/;
const BASH_FETCH = /\b(?:curl|wget)\b|\bgh\s+(?:api|issue|pr|release|repo)\b/;
const FENCES = ['[UNTRUSTED DATA', '⟪untrusted'];
const SUBAGENT_CALL = /^(?:Task|Agent)$/;

export function transcriptKey(file: string): string {
  return createHash('sha256').update(file).digest('hex').slice(0, 16);
}

/** The main transcript and every subagent transcript beside it. */
export function sessionTranscripts(main: string): string[] {
  const dir = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents');
  let subagents: string[] = [];
  try {
    subagents = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    // No subagents directory: no subagent ran, or this harness keeps none.
  }
  return [main, ...subagents];
}

interface Block {
  type?: unknown;
  name?: unknown;
  input?: unknown;
  text?: unknown;
  content?: unknown;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((item) =>
        item && typeof item === 'object'
          ? textOf((item as Block).text ?? (item as Block).content)
          : ''
      )
      .join('\n');
  return '';
}

/** Whether one transcript entry shows outside content, and whether it called a subagent. */
export function entryMarkers(entry: unknown): { outside: boolean; subagent: boolean } {
  const record = entry as { type?: unknown; message?: { content?: unknown }; mcpMeta?: unknown };
  const blocks = Array.isArray(record?.message?.content)
    ? (record.message!.content as Block[])
    : [];
  let outside = false;
  let subagent = false;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      const name = block.name;
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (SUBAGENT_CALL.test(name)) subagent = true;
      if (
        WEB_TOOL.test(name) ||
        MCP_FETCH.test(name) ||
        BROWSER.test(name) ||
        (name.startsWith('mcp__') && toolNameSuffix(name) === 'message')
      )
        outside = true;
      if (name === 'Bash' && typeof input.command === 'string' && BASH_FETCH.test(input.command))
        outside = true;
      if (
        name.startsWith('mcp__') &&
        toolNameSuffix(name) !== null &&
        input.acrossProjects === true
      )
        outside = true;
    }
    if (block.type === 'tool_result' && record.mcpMeta !== undefined) {
      const text = textOf(block.content);
      if (FENCES.some((fence) => text.includes(fence))) outside = true;
    }
  }
  return { outside, subagent };
}

export interface FileScan {
  /** The offset of the last complete line read: where the next scan of this file starts. */
  readonly scanned: number;
  readonly outside: boolean;
  readonly subagent: boolean;
  /** False when bytes were skipped or the deadline cut the scan short. */
  readonly complete: boolean;
  readonly bytes: number;
}

function readRange(file: string, start: number, end: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    let read = 0;
    while (read < buffer.length) {
      const n = fs.readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Scan what a file gained since `from`, whole lines only, at most `budget` bytes (the newest ones
 * when more were appended) and stopping at `deadlineAtMs`. A file shorter than `from` was
 * replaced: it is read from the start.
 */
export function scanFile(
  file: string,
  from: number,
  budget: number,
  deadlineAtMs: number = Infinity
): FileScan {
  const size = fs.statSync(file).size;
  const origin = size < from ? 0 : from;
  let start = origin;
  let complete = true;
  if (size - origin > budget) {
    start = size - budget;
    complete = false;
  }
  const buffer = readRange(file, start, size);
  let text = buffer.toString('utf8');
  let offset = start;
  if (start > origin) {
    // Skipped bytes: begin at the next whole line.
    const first = text.indexOf('\n');
    offset += first < 0 ? buffer.length : Buffer.byteLength(text.slice(0, first + 1));
    text = first < 0 ? '' : text.slice(first + 1);
  }
  const last = text.lastIndexOf('\n');
  const whole = last < 0 ? '' : text.slice(0, last + 1);
  let outside = false;
  let subagent = false;
  let consumed = 0;
  for (const line of whole.split('\n')) {
    if (Date.now() >= deadlineAtMs) {
      complete = false;
      break;
    }
    consumed += Buffer.byteLength(line) + 1;
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const markers = entryMarkers(entry);
    outside ||= markers.outside;
    subagent ||= markers.subagent;
  }
  const scanned = offset + Math.min(consumed, Buffer.byteLength(whole));
  // A writer may still be appending the last JSON line; it has not been inspected yet.
  if (scanned < size) complete = false;
  return { scanned, outside, subagent, complete, bytes: buffer.length };
}

/** The tail read when looking for the last reply. */
const TAIL_BYTES = 256 * 1024;

/**
 * s97-m12: whether the transcript's recent part holds a ScheduleWakeup or CronCreate call whose
 * prompt is `text`: a prompt the harness then sends at the time it was given. Claude Code runs the
 * prompt hook before it writes the prompt itself (2.1.301), but the call that scheduled it is
 * written when it is made. The tail read is SCAN_MAX_BYTES; the text is searched for first, and only
 * lines holding it are parsed. False when it is not found or the file cannot be read.
 */
export function scheduledPrompt(file: string, text: string): boolean {
  try {
    const size = fs.statSync(file).size;
    const tail = readRange(file, Math.max(0, size - SCAN_MAX_BYTES), size).toString('utf8');
    const quoted = JSON.stringify(text).slice(1, -1);
    if (!text || !tail.includes(quoted)) return false;
    for (const line of tail.split('\n')) {
      if (!line.includes(quoted) || !line.trim().startsWith('{')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const content = (entry as { message?: { content?: unknown } }).message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<{ type?: unknown; name?: unknown; input?: unknown }>)
        if (
          block?.type === 'tool_use' &&
          (block.name === 'ScheduleWakeup' || block.name === 'CronCreate') &&
          typeof (block.input as { prompt?: unknown } | undefined)?.prompt === 'string' &&
          (block.input as { prompt: string }).prompt.trim() === text
        )
          return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The text of the transcript's last assistant entry that has any, for a Stop whose input carries
 * no `last_assistant_message` (observed in Claude Code 2.1.292 but not documented). Null when the
 * tail holds none or cannot be read.
 */
export function lastAssistantText(file: string): string | null {
  try {
    const size = fs.statSync(file).size;
    const lines = readRange(file, Math.max(0, size - TAIL_BYTES), size)
      .toString('utf8')
      .split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const record = entry as { type?: unknown; message?: { content?: unknown } };
      if (record.type !== 'assistant') continue;
      const content = record.message?.content;
      const text = Array.isArray(content)
        ? content
            .filter(
              (block): block is { type: 'text'; text: string } =>
                !!block &&
                typeof block === 'object' &&
                (block as { type?: unknown }).type === 'text' &&
                typeof (block as { text?: unknown }).text === 'string'
            )
            .map((block) => block.text)
            .join('\n')
        : typeof content === 'string'
          ? content
          : '';
      if (text.trim()) return text;
    }
    return null;
  } catch {
    return null;
  }
}

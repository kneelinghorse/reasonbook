// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Checks the prompt actually delivered to the harness against stored offer counts and retained reasons.
// ABOUTME: A failed output or another Stop between preparation and delivery must not consume an unseen line.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import { prepareOffer } from '../../src/cli/drafts-hook';
import { offerCounts, openDraftRuntime, setShown } from '../../src/tools/rbook/draft-runtime';
import { replaceUnkept } from '../../src/tools/rbook/draft-runtime-unkept';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import { readTelemetry, targetForStore } from '../../src/tools/rbook/local-telemetry';
import { insertDraft, rawRunner } from '../../src/tools/rbook/proposals';
import { setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { seedRbookDb } from '../helpers/seedRbookDb';

const rawSessionId = 'delivery';
const session = harnessSessionHash(rawSessionId);
let tmp: string;
let dbPath: string;
let projectRoot: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-offer-delivery-'));
  projectRoot = path.join(tmp, 'project');
  dbPath = seedRbookDb(projectRoot);
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(tmp, 'config') };
});

afterEach(() => {
  setExternalSessionOwner(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedDrafts(count: number): void {
  const db = new Database(dbPath);
  try {
    for (let i = 0; i < count; i++)
      insertDraft(rawRunner(db), {
        text: `Preserve version 1.2.3 of the item with its exact name ${'😀'.repeat(140)}.`,
        kind: i % 2 ? 'rule' : 'decision',
        evidence: ['https://example.test/source?q=yes#section'],
        sourceSession: session,
        assistantExcerpt: null,
        outsideContent: 1,
        createdAt: new Date().toISOString(),
      });
  } finally {
    db.close();
  }
}

function stampNotes(word: string, now: number): string {
  const runtime = openDraftRuntime(dbPath, env)!;
  try {
    replaceUnkept(runtime, session, [{ text: word, reason: 'busy', detail: '' }], now);
    return runtime.path;
  } finally {
    runtime.close();
  }
}

function prepare(now = Date.now()) {
  return prepareOffer({
    dbPath,
    rawSessionId,
    message: 'continue',
    deadlineAtMs: Date.now() + 20_000,
    env,
    now,
  });
}

async function prompt(failOutput = false, message = 'continue') {
  let output = '';
  const errors: string[] = [];
  const io: CliIo = {
    cwd: projectRoot,
    env,
    startedAtMs: Date.now() + 20_000,
    readStdin: async () =>
      JSON.stringify({ session_id: rawSessionId, cwd: projectRoot, prompt: message }),
    stdout: (s) => {
      if (failOutput) throw new Error('test output unavailable');
      output += s;
    },
    stderr: (s) => errors.push(s),
  };
  await runCli(['hook', 'prompt'], io);
  return {
    text: output ? String(JSON.parse(output).hookSpecificOutput.additionalContext) : '',
    errors,
  };
}

const lastMeasurement = () =>
  readTelemetry(targetForStore(dbPath)!, env)
    .filter((r) => r.tool === 'hook prompt')
    .pop();

function stamps(): number[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare('SELECT id FROM proposals WHERE offered_at IS NOT NULL ORDER BY id').all() as {
        id: number;
      }[]
    ).map((row) => row.id);
  } finally {
    db.close();
  }
}

describe('whole entries are accounted for only when the harness receives them', () => {
  it('counts only delivered IDs on genuine overflow, retaining each displayed kind and warning', async () => {
    const total = 42;
    seedDrafts(total);
    const { text } = await prompt();
    expect(text.length).toBeLessThanOrEqual(1_000);
    const ids = [...text.matchAll(/\bP(\d+) \((decision|rule)\)/g)].map((match) =>
      Number(match[1])
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(total);
    expect(text).toContain(`${total - ids.length} more entries omitted.`);
    expect(stamps()).toEqual(ids);
    expect(lastMeasurement()?.draftsOffered).toBe(ids.length);
    const runtime = openDraftRuntime(dbPath, env, { readonly: true })!;
    try {
      expect(Array.from(offerCounts(runtime, session))).toEqual(ids.map((id) => [id, 1]));
    } finally {
      runtime.close();
    }
    for (const line of text.split('\n').filter((s) => /P\d+ \((decision|rule)\)/.test(s))) {
      expect(line).toMatch(/outside content/i);
      expect(line).toMatch(/evidence|It names/i);
      if (line.includes('--draft')) {
        expect(line).toMatch(
          /\(decision\).*If already answered, privately use drafts settle --draft P\d+ --decision N --project-root DIR\./
        );
      }
    }
  });

  it('leaves recall at least 300 units and delivers its five decisions after the exact offer', async () => {
    seedDrafts(42);
    const db = new Database(dbPath);
    const query = 'explain database resolution decisions';
    try {
      const insert = db.prepare(
        "INSERT INTO strategic_decisions (decision_text,created_at,status) VALUES (?,?,'active')"
      );
      for (let i = 0; i < 5; i++)
        insert.run(
          `Database resolution ${i}. ${'Retain the historical decisions. '.repeat(18)}`,
          new Date().toISOString()
        );
    } finally {
      db.close();
    }
    const expected = prepare().text;
    const { text } = await prompt(false, query);
    expect(text.startsWith(expected + '\n\nRelevant decisions:\n')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text.slice(expected.length + 2).length).toBeGreaterThanOrEqual(300);
    expect(lastMeasurement()?.idsInjected).toEqual(['d:1', 'd:2', 'd:3', 'd:4', 'd:5']);
  });

  it('identifies the declined kinds and their evidence without offering them again', async () => {
    seedDrafts(2);
    const runtime = openDraftRuntime(dbPath, env)!;
    try {
      setShown(runtime, session, [1, 2], Date.now());
    } finally {
      runtime.close();
    }
    const { text } = await prompt(false, 'no thanks');
    expect(text).toContain('declined P1, P2');
    for (const target of ['P1 (decision)', 'P2 (rule)']) {
      const row = text.split('\n').find((line) => line.includes(target));
      expect(row).toMatch(/evidence|It names/i);
      expect(row).toMatch(/outside content/i);
    }
    expect(text).not.toMatch(/fromDraft=|--draft/);
    expect(stamps()).toEqual([]);
    expect(lastMeasurement()?.draftsOffered).toBe(0);
  });

  it('retries the exact notes-only text after a failed stdout, then acknowledges it', async () => {
    stampNotes('first retained line', Date.now());
    const expected = prepare().text;
    expect(expected).toContain('first retained line');
    expect((await prompt(true)).errors.join(' ')).toContain('test output unavailable');
    expect((await prompt()).text).toBe(expected);
    expect((await prompt()).text).not.toContain('first retained line');
  });

  it('never reports offers, sets a first-offer time or consumes a reason after failed stdout', async () => {
    seedDrafts(1);
    stampNotes('retained after failed output', Date.now());
    expect((await prompt(true)).errors.join(' ')).toContain('test output unavailable');
    expect(lastMeasurement()?.draftsOffered ?? 0).toBe(0);
    expect(stamps()).toEqual([]);
    const { text } = await prompt();
    expect(text).toContain('retained after failed output');
    expect(lastMeasurement()?.draftsOffered).toBe(1);
    expect(stamps()).toEqual([1]);
    expect((await prompt()).text).not.toContain('retained after failed output');
  });

  it.each([0, 1])('keeps the newer same-millisecond Stop when %i drafts are pending', (count) => {
    seedDrafts(count);
    const now = Date.now();
    stampNotes('first retained line', now);
    const stale = prepare(now);
    expect(stale.text).toContain('first retained line');
    stampNotes('second retained line', now);
    stale.commit();
    const current = prepare(now);
    expect(current.text).toContain('second retained line');
    current.commit();
    expect(prepare(now).text).not.toContain('second retained line');
  });

  it('cannot recreate the notes-only runtime if it is removed after preparing', () => {
    const runtimePath = stampNotes('receipt belongs to the previous file', Date.now());
    const beforeRemoval = prepare();
    fs.unlinkSync(runtimePath);
    beforeRemoval.commit();
    expect(fs.existsSync(runtimePath)).toBe(false);
  });
});

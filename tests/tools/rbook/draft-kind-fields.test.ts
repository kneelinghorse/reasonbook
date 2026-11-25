// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 (#893) — fromDraft never reports success for a field a constraint, rule or profile draft's writer would
// ABOUTME: ignore: each of the 14 field-and-kind pairs is refused through the MCP dispatch, before the draft is claimed.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../../src/cli';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { setExternalSessionOwner } from '../../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const SESSION = 's109-m02-kind-fields';
let tmp: string;
let projectRoot: string;
let dbPath: string;
const savedConfig = process.env.RBOOK_CONFIG_DIR;
const savedSession = process.env.CLAUDE_CODE_SESSION_ID;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s109m02-893-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  delete process.env.CLAUDE_CODE_SESSION_ID;
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedRbookDb(projectRoot, { projectName: 'kind-fields' });
  reidentifyRbookTestStore(projectRoot);
  RbookDetector.resetInstance();
});

afterEach(() => {
  setExternalSessionOwner(null);
  if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfig;
  if (savedSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedSession;
  RbookDetector.resetInstance();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function hook(event: string, fields: Record<string, unknown>): Promise<void> {
  await runCli(['hook', event], {
    env: { ...process.env, CLAUDE_PID: String(process.pid) },
    cwd: projectRoot,
    startedAtMs: Date.now() + 20_000,
    readStdin: async () => JSON.stringify({ session_id: SESSION, cwd: projectRoot, ...fields }),
    stdout: () => {},
    stderr: () => {},
  });
  setExternalSessionOwner(null);
}

const TEXT: Readonly<Record<string, string>> = {
  constraint: 'Every hook finishes within its published deadline on this machine.',
  rule: 'Run the public-mirror gate before the full suite when tests name rbook paths.',
  profile: 'Ask questions in prose, never as multiple-choice menus.',
};

/** Propose a draft of the kind, and approve it plainly, as the operator would. */
async function approvedDraft(kind: string): Promise<string> {
  await hook('session-start', { source: 'startup' });
  await hook('stop', {
    last_assistant_message: `Proposed.\n\nWould record (${kind}): ${TEXT[kind]}`,
  });
  await hook('prompt', {
    prompt: `I approve this ${kind}: ${TEXT[kind]}`,
    prompt_id: `${Math.random()}`,
  });
  return 'P1';
}

async function record(params: Record<string, unknown>) {
  setExternalSessionOwner(SESSION);
  const answer = await executeMissionProtocolTool(
    'rbook_decisions',
    { action: 'record', projectRoot, ...params },
    await buildMissionProtocolContext()
  );
  setExternalSessionOwner(null);
  return answer.structuredContent as {
    success: boolean;
    error?: { code: string; field?: string; message: string };
  };
}

const outcome = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT outcome FROM proposals WHERE id = 1').get() as { outcome: string })
      .outcome;
  } finally {
    db.close();
  }
};

const SHARED: Array<[string, unknown]> = [
  ['evidence', [{ type: 'file', id: 'rbook/docs/architecture.md' }]],
  ['supersedes', [1]],
  ['citesLearningIds', [1]],
  ['domain', 'tooling'],
];
const PAIRS: Array<[string, string, unknown]> = [
  ...['constraint', 'rule', 'profile'].flatMap((kind) =>
    SHARED.map(([field, value]): [string, string, unknown] => [kind, field, value])
  ),
  ['profile', 'missionId', 's109-m02'],
  ['profile', 'sprintId', 'sprint-109'],
];

describe('#893: a field the kind’s writer would ignore is refused, and nothing is written', () => {
  it('counts the published 14 pairs', () => {
    expect(PAIRS).toHaveLength(14);
  });

  it.each(PAIRS)('a %s draft with %s', async (kind, field, value) => {
    const fromDraft = await approvedDraft(kind);
    const result = await record({ fromDraft, [field]: value });
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_PARAMETER', field });
    expect(result.error?.message).toContain(field);
    expect(outcome()).toBe('pending');
  });

  it('records the same draft once the field is left out, so the refusal is the field’s', async () => {
    const fromDraft = await approvedDraft('rule');
    expect((await record({ fromDraft, supersedes: [] })).success).toBe(true);
    expect(outcome()).toBe('approved');
  });

  it('a supersedes given on a rule draft leaves the named decision active', async () => {
    const db = new Database(dbPath);
    const decision = Number(
      db
        .prepare('INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)')
        .run('Keep the full suite in band on this machine.', new Date().toISOString())
        .lastInsertRowid
    );
    db.close();
    const fromDraft = await approvedDraft('rule');
    expect((await record({ fromDraft, supersedes: [decision] })).success).toBe(false);
    const read = new Database(dbPath, { readonly: true });
    try {
      expect(
        read
          .prepare('SELECT status, superseded_by FROM strategic_decisions WHERE id = ?')
          .get(decision)
      ).toEqual({ status: 'active', superseded_by: null });
    } finally {
      read.close();
    }
  });
});

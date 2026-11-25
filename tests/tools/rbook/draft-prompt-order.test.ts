// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Verifies that prompt answers attach only to the still-pending draft the operator saw.
// ABOUTME: Independent SQLite connections interleave at the initial read and after consuming shown.
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onStop, prepareOffer } from '../../../src/cli/drafts-hook';
import * as hookStores from '../../../src/cli/drafts-hook-runtime';
import {
  bindWindow,
  openDraftRuntime,
  openWindow,
  pendingDeclines,
  readExcerpt,
  type DraftRuntime,
} from '../../../src/tools/rbook/draft-runtime';
import { namesApprovedDraft } from '../../../src/tools/rbook/draft-evaluation';
import * as showing from '../../../src/tools/rbook/draft-runtime-shown';
import { harnessSessionHash } from '../../../src/tools/rbook/harness-session';
import * as proposals from '../../../src/tools/rbook/proposals';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import {
  prepareUploadServerSources,
  uploadServerSourceLoader,
} from '../../helpers/upload-server-source';

const session = 'prompt-order';
const hash = harnessSessionHash(session);
const choice = 'Keep the import report alongside the source data for the next run.';
const named = `Yes, ${choice}`;
let compiled: string;
let cliFile: string;
let root: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
let now: number;
let project: Database.Database;
let runtime: DraftRuntime;

beforeAll(() => {
  const repo = path.resolve(__dirname, '../../..');
  compiled = prepareUploadServerSources(repo, ['src/cli.ts', 'src/cli/private-settle.ts']);
  cliFile = path.join(compiled, 'settle.cjs');
  fs.writeFileSync(
    cliFile,
    uploadServerSourceLoader(compiled) +
      '\n' +
      `require(${JSON.stringify(path.join(repo, 'src/cli.ts'))}).main(process.argv.slice(2));`
  );
});
afterAll(() => {
  if (compiled) fs.rmSync(compiled, { recursive: true, force: true });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-prompt-order-'));
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(root, 'config') };
  dbPath = seedRbookDb(path.join(root, 'project'), { projectName: 'prompt-order' });
  now = Date.now();
  onStop({
    dbPath,
    env,
    rawSessionId: session,
    reply: `Would record: ${choice}`,
    deadlineAtMs: Date.now() + 20_000,
    now: now - 2000,
  });
  project = new Database(dbPath, { fileMustExist: true, timeout: 0 });
  project
    .prepare(
      "INSERT INTO sessions(id,type,title,started_at,owner_key,project_id) VALUES('owner','custom','Import',?,?,'prompt-order')"
    )
    .run(new Date(now - 3000).toISOString(), 'ext:' + hash);
  project
    .prepare(
      "INSERT INTO strategic_decisions(id,decision_text,created_at,status,author_session_id,project_id) VALUES(7,?,?,'active','owner','prompt-order')"
    )
    .run(choice, new Date(now - 1000).toISOString());
  runtime = openDraftRuntime(dbPath, env, { timeoutMs: 0 })!;
});

afterEach(() => {
  jest.restoreAllMocks();
  runtime?.close();
  project?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function answer(message: string) {
  return prepareOffer({
    dbPath,
    env,
    rawSessionId: session,
    message,
    deadlineAtMs: Date.now() + 20_000,
    now,
  });
}

function settle() {
  return spawnSync(
    process.execPath,
    [
      cliFile,
      'drafts',
      'settle',
      '--draft',
      'P1',
      '--decision',
      '7',
      '--project-root',
      path.join(root, 'project'),
    ],
    {
      encoding: 'utf8',
      env: { ...env, RBOOK_CHECKPOINT_SYNC: 'off', RBOOK_SHARED_SYNC: 'off' },
      timeout: 20_000,
    }
  );
}

it.each(['yes', 'no'])(
  'an answer already committed at the initial read wins over "%s"',
  (message) => {
    const pending = proposals.pendingDrafts;
    const completed = jest.spyOn(proposals, 'pendingDrafts').mockImplementationOnce((run) => {
      const rows = pending(run);
      expect(settle()).toMatchObject({
        status: 0,
        stdout: expect.stringMatching(/settled P1 by d:7/i),
      });
      return rows;
    });
    const offer = answer(message);
    expect(completed).toHaveBeenCalled();
    expect(offer.reply).toBeNull();
    expect(offer.offered).toBe(0);
    expect(readExcerpt(runtime, hash, 1, now)).toBeNull();
    expect(openWindow(runtime, hash, now)).toEqual([]);
    expect(project.prepare('SELECT outcome, record_id FROM proposals WHERE id=1').get()).toEqual({
      outcome: 'answered',
      record_id: 'd:7',
    });
  }
);

it.each([named, 'no'])(
  'the prompt protects both stores through binding "%s" to the showing',
  (message) => {
    const take = showing.takeShown;
    const taken = jest.spyOn(showing, 'takeShown').mockImplementationOnce((...args) => {
      const ids = take(...args);
      expect(ids).toEqual([1]);
      for (const competitor of [runtime.db, project]) {
        expect(() => competitor.transaction(() => {}).immediate()).toThrow(
          expect.objectContaining({ code: 'SQLITE_BUSY' })
        );
      }
      expect(settle()).toMatchObject({ status: 1, stderr: expect.stringMatching(/busy.*retry/i) });
      return ids;
    });
    const offer = answer(message);
    expect(taken).toHaveBeenCalledTimes(1);
    const reply = message === named ? 'approval' : 'decline';
    expect(offer.reply).toBe(reply);
    expect(readExcerpt(runtime, hash, 1, now)).toMatchObject({ message, reply });
    expect(openWindow(runtime, hash, now)).toEqual(message === named ? [1] : []);
    expect(project.prepare('SELECT outcome FROM proposals WHERE id=1').get()).toEqual({
      outcome: message === named ? 'pending' : 'declined',
    });
    expect(settle()).toMatchObject({
      status: 1,
      stderr: expect.stringMatching(message === named ? /protected|window/i : /declined/i),
    });
    expect(project.prepare('SELECT count(*) FROM strategic_decisions').pluck().get()).toBe(1);
  }
);

it('keeps the prompt unbound when an active project writer prevents a fresh approval', () => {
  project.exec('BEGIN IMMEDIATE');
  try {
    const offer = answer('yes');
    expect(offer.reply).toBeNull();
    expect(readExcerpt(runtime, hash, 1, now)).toBeNull();
    expect(openWindow(runtime, hash, now)).toEqual([]);
  } finally {
    project.exec('ROLLBACK');
  }
});

it.each(['continue', 'no'])(
  'consumes the current-only question on a busy project while processing "%s"',
  (message) => {
    showing.setShown(runtime, hash, [1], now, true);
    project.exec('BEGIN IMMEDIATE');
    try {
      answer(message);
      expect(showing.peekShown(runtime, hash, now)).toEqual([]);
      expect(pendingDeclines(runtime)).toEqual([]);
      expect(openWindow(runtime, hash, now)).toEqual([]);
      expect(project.prepare('SELECT outcome FROM proposals WHERE id=1').pluck().get()).toBe(
        'pending'
      );
    } finally {
      project.exec('ROLLBACK');
    }
  }
);

it('clears the current-only showing before surfacing a project open error', () => {
  showing.setShown(runtime, hash, [1], now, true);
  const open = hookStores.openStore;
  const failure = Object.assign(new Error('fixture write unavailable'), { code: 'SQLITE_IOERR' });
  jest.spyOn(hookStores, 'openStore').mockImplementation((file, readonly, deadline) => {
    if (!readonly) throw failure;
    return open(file, readonly, deadline);
  });
  expect(() => answer('continue')).toThrow(failure);
  expect(showing.peekShown(runtime, hash, now)).toEqual([]);
  expect(pendingDeclines(runtime)).toEqual([]);
});

it.each(['yes', 'yes, please', 'record it', 'sounds good'])(
  'a context-free answer creates no evidence for a legacy showing: %s',
  (message) => {
    expect(answer(message).reply).toBeNull();
    expect(readExcerpt(runtime, hash, 1, now)).toBeNull();
    expect(openWindow(runtime, hash, now)).toEqual([]);
  }
);

it.each([false, true])(
  'an old tagged question clears earlier evidence on a busy project (%s)',
  (busy) => {
    bindWindow(runtime, hash, [1], 'An earlier discussion.', 'other', now - 100);
    runtime.db
      .prepare('UPDATE shown SET draft_ids = ? WHERE session = ?')
      .run(JSON.stringify({ question: 1, proof: 'older hook token' }), hash);
    if (busy) project.exec('BEGIN IMMEDIATE');
    try {
      expect(answer('yes').reply).toBeNull();
      expect(readExcerpt(runtime, hash, 1, now)).toBeNull();
      expect(openWindow(runtime, hash, now)).toEqual([]);
      expect(showing.peekShown(runtime, hash, now)).toEqual([]);
    } finally {
      if (busy) project.exec('ROLLBACK');
    }
  }
);

it('binds the full named choice and preserves every word of its confirmation', () => {
  showing.setShown(runtime, hash, [1], now, true);
  const words = named;
  expect(answer(words).reply).toBe('approval');
  expect(readExcerpt(runtime, hash, 1, now)).toMatchObject({
    message: words,
    reply: 'approval',
    windowSize: 1,
  });
  expect(openWindow(runtime, hash, now)).toEqual([1]);
});

it.each(['I approve this decision: ', 'Yes, ', 'I approve '])(
  'binds only the literal choice after the confirmation prefix %s',
  (prefix) => {
    const draft = 'Route `Release  notes.md` to /reports?format=weekly.';
    project.prepare('UPDATE proposals SET text=? WHERE id=1').run(draft);
    for (const different of [
      draft.replace('  ', ' '),
      draft.replace('  ', '\t'),
      draft.replace('weekly', 'daily'),
      draft.slice(0, -1),
      draft + ' ',
      ' ' + draft,
      draft + '?',
    ]) {
      expect(answer(prefix + different).reply).toBeNull();
      expect(readExcerpt(runtime, hash, 1, now)).toBeNull();
      expect(openWindow(runtime, hash, now)).toEqual([]);
    }
    expect(answer(prefix + draft).reply).toBe('approval');
    expect(readExcerpt(runtime, hash, 1, now)?.message).toBe(prefix + draft);
  }
);

it.each([
  [
    '/reports?format=weekly is the source of the report.',
    '/reports?format=weekly is the source of the report.',
  ],
  ['Use `Release  notes.md` for reports.', 'Use `Release notes.md` for reports.'],
  ['Record the weekly report.', 'Record the weekly report'],
])('checks old approval excerpts against the verbatim draft %s', (draft, supplied) => {
  const stored = {
    reply: 'approval',
    message: 'I approve this decision: ' + supplied,
    windowSize: 1,
    at: now,
    late: false,
  };
  const row = { ...proposals.getDraft(proposals.rawRunner(project), 1)!, text: draft };
  expect(namesApprovedDraft(stored, row)).toBe(supplied === draft);
});

it('recognizes an explicit kind and choice after an unverified yes has consumed the question', () => {
  project.prepare('UPDATE proposals SET source_session = ? WHERE id = 1').run('earlier-chat');
  showing.setShown(runtime, hash, [1], now, true);
  expect(answer('yes').reply).toBeNull();
  const words = 'I approve this decision: ' + choice;
  expect(answer(words).reply).toBe('approval');
  expect(readExcerpt(runtime, hash, 1, now)?.message).toBe(words);
});

it.each(['rule', 'constraint', 'profile'])(
  '%s approval identifies the kind and the entire choice',
  (kind) => {
    project.prepare('UPDATE proposals SET kind=? WHERE id=1').run(kind);
    showing.setShown(runtime, hash, [1], now, true);
    expect(answer(named).reply).toBeNull();
    expect(readExcerpt(runtime, hash, 1, now)).toBeNull();
    const words = 'I approve this ' + kind + ': ' + choice;
    expect(answer(words).reply).toBe('approval');
    expect(readExcerpt(runtime, hash, 1, now)?.message).toBe(words);
  }
);

it.each([
  '    I approve this decision: ' + choice,
  'Yes, Keep the import report.',
  'Yes, ' + choice + ' Or move it to the archive.',
  'Yes, "' + choice + '"',
  'Yes, ' + choice.replace('next', 'first'),
  'Yes, ' + choice + '?',
  'Yes, ' + choice + '\nFurther discussion.',
  'Yes, ' + ' '.repeat(1000) + choice,
])('an incomplete or qualified named reply leaves the choice awaiting confirmation', (message) => {
  expect(answer(message).reply).toBeNull();
  expect(readExcerpt(runtime, hash, 1, now)).toBeNull();
  expect(openWindow(runtime, hash, now)).toEqual([]);
});

it.each([
  'Use the `import_report` command for this job.',
  '`import_report` is the command for this job.',
])('preserves an inline identifier in the full named choice: %s', (text) => {
  project.prepare('UPDATE proposals SET text=? WHERE id=1').run(text);
  expect(answer('I approve this decision: ' + text).reply).toBe('approval');
  expect(readExcerpt(runtime, hash, 1, now)?.message).toBe('I approve this decision: ' + text);
});

it.each([
  ['> I approve this decision: ' + choice, 'other'],
  ['yes, but keep the original report', 'other'],
  ['yes, but why keep the report?', 'question'],
  ['yes, this looks good. Where is the meeting room?', 'question'],
])('preserves an explicit legacy discussion without marking it approved', (message, expected) => {
  const offer = answer(message);
  expect(offer.reply).toBe(expected);
  expect(readExcerpt(runtime, hash, 1, now)?.reply).toBe(expected);
});

it('requires a unique target for an unqualified named choice, including across kinds', () => {
  project
    .prepare(
      "INSERT INTO proposals (text,kind,source_session,created_at) SELECT text,'rule',source_session,created_at FROM proposals WHERE id=1"
    )
    .run();
  showing.setShown(runtime, hash, [1], now, true);
  expect(answer(named).reply).toBeNull();
  expect(readExcerpt(runtime, hash, 1, now)).toBeNull();
  expect(readExcerpt(runtime, hash, 2, now)).toBeNull();
  expect(answer('I approve this rule: ' + choice).reply).toBe('approval');
  expect(readExcerpt(runtime, hash, 1, now)).toBeNull();
  expect(readExcerpt(runtime, hash, 2, now)?.reply).toBe('approval');
});

it('a busy store does not bind a refusal to a draft carried from an earlier reply', () => {
  onStop({
    dbPath,
    env,
    rawSessionId: session,
    reply: 'Continuing with the import.',
    deadlineAtMs: Date.now() + 20_000,
    now,
  });
  project.exec('BEGIN IMMEDIATE');
  try {
    const offer = answer('no');
    expect(offer.reply).toBeNull();
    expect(readExcerpt(runtime, hash, 1, now)).toBeNull();
    expect(openWindow(runtime, hash, now)).toEqual([]);
  } finally {
    project.exec('ROLLBACK');
  }
});

it('a failed project update retains a refusal and its lease until the store can save it', () => {
  project.exec(`CREATE TRIGGER withheld_decline BEFORE UPDATE OF outcome ON proposals
    WHEN NEW.outcome = 'declined' BEGIN SELECT RAISE(ABORT, 'fixture withholds decline'); END`);
  const offer = answer('no');
  expect(offer.text).toContain('retained');
  expect(offer.text).not.toContain('The operator declined');
  expect(showing.readShown(runtime, hash, now)).toMatchObject({ ids: [1], at: now - 2000 });
  expect(readExcerpt(runtime, hash, 1, now)).toMatchObject({ reply: 'decline' });
  expect(project.prepare('SELECT outcome FROM proposals').get()).toEqual({ outcome: 'pending' });
  project.exec('DROP TRIGGER withheld_decline');
  answer('continue');
  expect(project.prepare('SELECT outcome FROM proposals').get()).toEqual({ outcome: 'declined' });
});

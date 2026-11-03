// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — every surface that teaches the "Settled:" line carries both of its clauses: above any Would record
// ABOUTME: lines (a 4.10.0 hook stops reading there) and the draft named only in that line (an older hook binds prose).

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../../src/cli';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { DRAFTS_ASK } from '../../../src/tools/rbook/digest-v2';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { setExternalSessionOwner } from '../../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const ABOVE = /above any Would record lines/;
const ONLY = /nam(?:e|ing) the draft only in that line/;

let tmp: string;
let projectRoot: string;
const savedConfig = process.env.RBOOK_CONFIG_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s109m02-teach-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  seedRbookDb(projectRoot, { projectName: 'teach' });
  reidentifyRbookTestStore(projectRoot);
  RbookDetector.resetInstance();
});

afterEach(() => {
  setExternalSessionOwner(null);
  if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function hook(event: string, fields: Record<string, unknown>): Promise<string> {
  let stdout = '';
  await runCli(['hook', event], {
    env: { ...process.env, CLAUDE_PID: String(process.pid) },
    cwd: projectRoot,
    startedAtMs: Date.now() + 20_000,
    readStdin: async () => JSON.stringify({ session_id: 's-teach', cwd: projectRoot, ...fields }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  });
  setExternalSessionOwner(null);
  return stdout ? (JSON.parse(stdout).hookSpecificOutput.additionalContext as string) : '';
}

const PROPOSAL =
  'Proposed.\n\nWould record: Store project decisions as one JSON file per decision, because diffs stay readable.';

describe('the settle line is taught with both clauses everywhere it is taught (settled item 1)', () => {
  it('the reminder of a pending decision draft', async () => {
    await hook('session-start', { source: 'startup' });
    await hook('stop', { last_assistant_message: PROPOSAL });
    await hook('prompt', { prompt: 'Let us look at the export command', prompt_id: 'a' });
    const reminder = await hook('prompt', { prompt: 'Now the import command', prompt_id: 'b' });
    expect(reminder).toContain('Still pending: P1');
    expect(reminder).toContain('"Settled: P1 by decision <N>"');
    expect(reminder).toMatch(ABOVE);
    expect(reminder).toMatch(/name the draft only in that line/);
  });

  it('the digest’s ask', () => {
    expect(DRAFTS_ASK).toContain('"Settled: P<n> by decision <N>"');
    expect(DRAFTS_ASK).toMatch(ABOVE);
    expect(DRAFTS_ASK).toMatch(ONLY);
  });

  it('the approval-required suggestion for a decision draft nobody answered here', async () => {
    await hook('session-start', { source: 'startup' });
    await hook('stop', { last_assistant_message: PROPOSAL });
    setExternalSessionOwner('s-teach');
    const result = await rbookDecisions({ action: 'record', fromDraft: 'P1', projectRoot });
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    const suggestion = result.error?.suggestion ?? '';
    expect(suggestion).toContain('"Settled: P1 by decision <N>"');
    expect(suggestion).toMatch(ABOVE);
    expect(suggestion).toMatch(ONLY);
    expect(suggestion).toContain(
      'Otherwise end a reply with "Would record: Store project decisions'
    );
    // Within error-bounds.ts's limit, so no layer cuts it to a preview.
    expect(JSON.stringify(suggestion).length).toBeLessThanOrEqual(512);
  });

  it('the record-decision skill', () => {
    const skill = fs.readFileSync(
      path.join(__dirname, '../../../plugins/reasonbook/skills/record-decision/SKILL.md'),
      'utf8'
    );
    expect(skill).toContain('Settled: P<n> by decision <N>');
    expect(skill).toMatch(ABOVE);
    expect(skill).toMatch(/name the draft only in\s+that line/);
    expect(skill).toMatch(/`settled`,\s+which is a draft's mode and never a decision's/);
  });
});

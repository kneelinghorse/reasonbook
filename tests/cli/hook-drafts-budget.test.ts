// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Replays the earlier-draft length band and short and long offers through actual hooks.
// ABOUTME: Reads the delivered context to check approval scope and the reasons owed to the operator.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';
import { type CliIo } from '../../src/cli/core';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { openDraftRuntime, readExcerpt } from '../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import { setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../helpers/seedRbookDb';

let tmp: string;
let projectRoot: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
const session = 'draft-offer-band';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-draft-offer-band-'));
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot);
  dbPath = seedRbookDb(projectRoot, { projectName: 'bounded offers' });
  reidentifyRbookTestStore(projectRoot);
  RbookDetector.resetInstance();
  env = {
    ...process.env,
    CLAUDE_PID: String(process.pid),
    RBOOK_CONFIG_DIR: path.join(tmp, 'config'),
  };
  delete env.CLAUDE_CODE_SESSION_ID;
});
afterEach(() => {
  setExternalSessionOwner(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function hook(event: string, input: Record<string, unknown>): Promise<string> {
  let output = '';
  const io: CliIo = {
    env,
    cwd: projectRoot,
    startedAtMs: Date.now() + 20_000,
    readStdin: async () => JSON.stringify({ ...input, session_id: session, cwd: projectRoot }),
    stdout: (value) => {
      output += value;
    },
    stderr: () => {},
  };
  expect(await runCli(['hook', event], io)).toBe(0);
  setExternalSessionOwner(null);
  return output ? JSON.parse(output).hookSpecificOutput.additionalContext : '';
}

function excerpt(id: number) {
  const runtime = openDraftRuntime(dbPath, env, { readonly: true })!;
  try {
    return readExcerpt(runtime, harnessSessionHash(session), id, Date.now());
  } finally {
    runtime.close();
  }
}

const start = () => hook('session-start', { source: 'startup' });
const stop = (reply: string) => hook('stop', { last_assistant_message: reply });
const say = (prompt: string) => hook('prompt', { prompt, prompt_id: String(Math.random()) });
const proposing = (...lines: string[]) =>
  'Here is the plan.\n\n' + lines.map((line) => 'Would record: ' + line).join('\n');

const BAND_CHOICES = [
  'Save decisions as JSON files because they diff cleanly.',
  'Hold one SQLite store per project because sync expects one.',
  'Count every hook call because the load gate reads them.',
];
const BAND_NOTIFY =
  '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>';
const BAND_BASE = 'Store decisions as JSON files because they diff cleanly in every code review';
const BAND_PADDING =
  ' and in every audit of the record that a later session reads back to check the reasons';

async function showBand(extra: number): Promise<void> {
  const earlier = `${BAND_BASE}${BAND_PADDING.repeat(3).slice(0, extra)}.`.replace(/\s+\./, '.');
  await start();
  await stop(proposing(earlier));
  await say(BAND_NOTIFY);
  await stop(proposing(...BAND_CHOICES));
}

describe('a carried draft cannot acquire the next reply’s approval across the historical cut band', () => {
  it.each(Array.from({ length: 71 }, (_, i) => 90 + i))(
    'keeps the question whole with %i extra characters',
    async (extra) => {
      await showBand(extra);
      const offer = await say('yes, but weekly. When is the CI bill due?');
      expect(offer.length).toBeLessThanOrEqual(1000);
      expect(offer).toContain('Answer the question.');
      expect(offer).toContain('Leave P2, P3, P4 pending');
      expect(offer).not.toMatch(/fromDraft|rbook_decisions\(action="record"|…$/);
      expect(offer).toMatch(/P1 \(decision\)[^\n]*shown before|shown before[^\n]*P1 \(decision\)/i);
      expect(excerpt(1)).toMatchObject({ reply: 'other' });
    }
  );

  it('prints a recording call only after naming the approved choice, with its own target', async () => {
    await showBand(120);
    const offer = await say(`I approve this decision: ${BAND_CHOICES[1]}`);
    const calls = [...offer.matchAll(/rbook_decisions\(action="record", fromDraft="(P\d+)"\)/g)];
    expect(calls.map((match) => match[1])).toEqual(['P3']);
    expect(offer.slice(0, calls[0].index)).toMatch(/approval of P3\b/i);
    expect(offer).not.toMatch(/fromDraft="P[124]"/);
  });
});

describe('the visible offer preserves every reason the agent owes the operator', () => {
  it.each([
    ['R1', true, 0],
    ['R2', false, 80],
  ] as const)(
    '%s retains two overflowed lines and any refused settlement',
    async (_fixture, withSettle, width) => {
      const bound = BAND_CHOICES.map((choice) => (width ? choice.padEnd(width, 'x') : choice));
      const losses = [
        'Explain why the workspace uses a distinct environment for each project.',
        'Document the output size for all four thousand characters of the report.',
      ];
      const proposed = proposing(...bound, ...losses);
      await start();
      await stop(
        withSettle
          ? proposed.replace(
              'Here is the plan.\n\n',
              'Here is the plan.\n\nSettled: P99 by decision 1\n'
            )
          : proposed
      );
      const offer = await say('why these?');
      expect(offer.length).toBeLessThanOrEqual(1000);
      expect(offer).toContain('Answer the question.');
      expect(
        offer.match(
          /(?:at most three|three[- ](?:proposal|draft|line)|3[- ](?:proposal|draft|line))/gi
        )
      ).toHaveLength(2);
      if (withSettle)
        expect(offer).toMatch(
          /no such draft|draft (?:was |is )?(?:missing|not found)|unknown draft/i
        );
    }
  );

  it('retains the outside-content and evidence status of each long draft before optional link text', async () => {
    const transcript = path.join(tmp, 'outside.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.test' } }],
        },
      }) + '\n'
    );
    const long = BAND_CHOICES.map(
      (choice, i) =>
        `${choice} See ${[0, 1, 2].map((n) => 'https://example.test/' + i + '/' + n + '/' + 'abc.123;xyz'.repeat(8)).join(' ')} for the complete reference.`
    );
    await start();
    await hook('stop', {
      last_assistant_message: proposing(
        ...long,
        'Keep one final audit copy so this excluded line has an explanation.'
      ),
      transcript_path: transcript,
    });
    const offer = await say('why these?');
    expect(offer.length).toBeLessThanOrEqual(1000);
    expect(offer).toMatch(
      /at most three|three[- ](?:proposal|draft|line)|3[- ](?:proposal|draft|line)/i
    );
    for (const label of ['P1', 'P2', 'P3']) {
      const line = offer.split('\n').find((line) => line.includes(`${label} (decision)`));
      expect(line).toMatch(/outside content/i);
      expect(line).toMatch(/evidence|it names/i);
    }
  });
});

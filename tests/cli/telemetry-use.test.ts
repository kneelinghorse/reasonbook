// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves injected context citations count through a real store and MCP telemetry boundary.
// ABOUTME: Session-start source survives dispatch without recording arbitrary hook input.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import { readTelemetry, targetForStore } from '../../src/tools/rbook/local-telemetry';
import { rbookDecisionsRecord } from '../../src/tools/rbook/rbook-decisions-record';
import { setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { withMcpTelemetry } from '../../src/tools/rbook/telemetry-call';
import { eventStatistics } from '../../src/tools/rbook/telemetry-stats-events';
import { seedRbookDb } from '../helpers/seedRbookDb';

let tmp: string;
let root: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
const savedConfig = process.env.RBOOK_CONFIG_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-telemetry-use-'));
  root = path.join(tmp, 'project');
  dbPath = seedRbookDb(root, { projectId: 'telemetry-use' });
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(tmp, 'config'), CLAUDE_PROJECT_DIR: '' };
  process.env.RBOOK_CONFIG_DIR = env.RBOOK_CONFIG_DIR;
});
afterEach(() => {
  setExternalSessionOwner(null);
  if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function inject(source?: string): Promise<void> {
  // This suite tests source filtering and citation attribution, not the hook's real-time
  // deadline. Keep real I/O and digest work; deadline behavior has its own clock-driven tests.
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'performance',
      'nextTick',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
    ],
  });
  let stdout = '';
  let stderr = '';
  try {
    expect(
      await runCli(['hook', 'session-start'], {
        env,
        cwd: root,
        readStdin: async () => JSON.stringify({ session_id: 'citation-session', source }),
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      })
    ).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout).hookSpecificOutput).toMatchObject({
      hookEventName: 'SessionStart',
      additionalContext: expect.any(String),
    });
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
  } finally {
    jest.useRealTimers();
  }
}

it.each(['startup', 'resume', 'clear', 'compact', undefined, 'private source'])(
  'records only the known session-start source %p at the actual hook boundary',
  async (source) => {
    await inject(source);
    const rows = readTelemetry(targetForStore(dbPath)!, env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'hook session-start', ok: true, failOpen: null });
    expect(rows[0].charsInjected).toBeGreaterThan(0);
    expect((rows[0] as unknown as { source?: string }).source).toBe(
      source === 'private source' ? undefined : source
    );
    expect(JSON.stringify(rows)).not.toContain('private source');
  }
);

it('credits a context-only citation after a real digest injection in the same session', async () => {
  const db = new Database(dbPath);
  const inserted = db
    .prepare(
      'INSERT INTO strategic_decisions (decision_text, created_at, project_id) VALUES (?, ?, ?)'
    )
    .run('Keep the user-facing record concise.', new Date().toISOString(), 'telemetry-use');
  db.close();
  const id = Number(inserted.lastInsertRowid);
  await inject('startup');
  const target = targetForStore(dbPath)!;
  expect(readTelemetry(target, env)[0].idsInjected).toContain(`d:${id}`);
  await new Promise((resolve) => setTimeout(resolve, 2));
  setExternalSessionOwner('citation-session');
  const args = {
    action: 'record',
    content: 'Keep the full rationale in the supporting field.',
    context: `Applies decision #${id}.`,
    projectRoot: root,
    mode: 'autonomous' as const,
  };
  const result = await withMcpTelemetry(
    { name: 'rbook_decisions', args, mode: 'write', client: 'test', env },
    async () => ({ structuredContent: await rbookDecisionsRecord(args) })
  );
  expect(result.structuredContent.success).toBe(true);
  const rows = readTelemetry(target, env);
  expect(rows[1]).toMatchObject({
    session: `ext:${harnessSessionHash('citation-session')}`,
    idsCited: [`d:${id}`],
  });
  expect(eventStatistics([{ target: 'scratch', records: rows }]).citeThrough.digest.used).toBe(1);
});

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Seeds a temporary project and its separate private draft runtime for settlement tests.
// ABOUTME: Every call to the CLI uses the pair's explicit root, isolated config and local database.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../src/cli';
import { openDraftRuntime } from '../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import { setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { seedRbookDb } from './seedRbookDb';

export function createSettlementFixture() {
  const choice = 'Keep the weekly status export in the planning folder.';
  const owner = harnessSessionHash('the-originating-chat');
  const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-private-settle-'));
  const root = path.join(tmp, 'project');
  const env = { ...process.env, RBOOK_CONFIG_DIR: path.join(tmp, 'config') };
  const store = new Database(seedRbookDb(root, { projectId: 'fixture' }));
  store
    .prepare(
      "INSERT INTO sessions(id,type,title,started_at,owner_key,project_id) VALUES('origin','custom','Planning',?,?,'fixture')"
    )
    .run(iso(-4000), 'ext:' + owner);
  store
    .prepare('INSERT INTO proposals(id,text,created_at,source_session) VALUES(1,?,?,?)')
    .run(choice, iso(-3000), owner);
  store
    .prepare(
      "INSERT INTO strategic_decisions(id,decision_text,created_at,status,author_session_id,project_id) VALUES(7,?,?,'active','origin','fixture')"
    )
    .run(choice, iso(-2000));
  const runtime = openDraftRuntime(store.name, env)!;
  const selected = ['drafts', 'settle', '--draft', 'P1', '--decision', '7', '--project-root', root];
  async function cli(argv = selected, environment: NodeJS.ProcessEnv = env) {
    let out = '';
    let err = '';
    const code = await runCli(argv, {
      env: environment,
      cwd: tmp,
      readStdin: async () => '',
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    });
    return { code, out, err };
  }

  function close() {
    setExternalSessionOwner(null);
    if (runtime.db.open) runtime.close();
    if (store.open) store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { tmp, root, env, store, runtime, selected, cli, close };
}

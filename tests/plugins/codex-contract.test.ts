// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Checks Codex-specific entrypoints and pins the hook definitions the operator trusts.
// ABOUTME: Claude entrypoints remain covered by their existing independent package contract.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectNpmPack } from '../docs/npm-pack-inspection';
import { deriveEnvReads } from '../helpers/env-reads';

const root = path.resolve(__dirname, '../..');
const json = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const plugin = 'plugins/reasonbook';
const verbs = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  Stop: 'stop',
  PreCompact: 'pre-compact',
  SessionEnd: 'session-end',
};

test('Codex chooses a dedicated manifest and a relative server command without shell expansion', () => {
  const manifest = json(`${plugin}/.codex-plugin/plugin.json`);
  expect(manifest).toMatchObject({
    name: 'reasonbook',
    version: json('package.json').version,
    skills: './skills/',
    hooks: './hooks/codex.json',
    mcpServers: './codex.mcp.json',
  });
  expect(json(`${plugin}/codex.mcp.json`)).toEqual({
    mcpServers: {
      rbook: {
        command: '/bin/sh',
        args: ['./hooks/launch.sh', 'serve', '--install-root', 'shared'],
        cwd: '.',
        env_vars: expect.arrayContaining([
          'RBOOK_CONFIG_DIR',
          'RBOOK_CONFIG_DIR',
          'RBOOK_PROJECT_ROOT',
          'RBOOK_PROJECT_ROOT',
        ]),
      },
    },
  });
});

test('trusted hook definitions remain exact and contain no release version', () => {
  const hooks = json(`${plugin}/hooks/codex.json`).hooks;
  expect(Object.keys(hooks).sort()).toEqual(Object.keys(verbs).sort());
  for (const [event, verb] of Object.entries(verbs)) {
    expect(hooks[event]).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: `node "\${PLUGIN_ROOT}/hooks/run.mjs" hook ${verb} --harness codex --install-root shared --hook-source rbook-codex-plugin`,
            timeout: event === 'SessionStart' ? 3 : 1,
          },
        ],
      },
    ]);
  }
});

test('Codex forwards server settings except the edition selected by its contained marker', () => {
  const forwarded: string[] = json(`${plugin}/codex.mcp.json`).mcpServers.rbook.env_vars;
  expect(forwarded.filter((name) => name.startsWith('RBOOK_')).sort()).toEqual(
    [...deriveEnvReads(path.join(root, 'src'))].filter((name) => name !== 'RBOOK_EDITION').sort()
  );
});

test('the OpenAI marketplace names both plugin subtrees and ships in npm', () => {
  const marketplace = json('.agents/plugins/marketplace.json');
  expect(marketplace.name).toBe('reasonbook');
  expect(marketplace.plugins.map((entry: any) => [entry.name, entry.source])).toEqual([
    ['reasonbook', { source: 'local', path: './plugins/reasonbook' }],
    ['reasonbook-chat', { source: 'local', path: './plugins/reasonbook-chat' }],
  ]);
  for (const entry of marketplace.plugins)
    expect(entry.policy).toEqual({ installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  const packed = inspectNpmPack(root).files;
  for (const file of [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    `${plugin}/.codex-plugin/plugin.json`,
    `${plugin}/codex.mcp.json`,
    `${plugin}/hooks/launch.sh`,
  ]) {
    expect({ file, packed: packed.has(file) }).toEqual({ file, packed: true });
  }
});

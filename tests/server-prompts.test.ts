// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises portable Reasonbook commands through a real MCP client and transport.
// ABOUTME: Keeps prompt bodies tied to the shipped skill sources and rejects unusable requests.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Server, InMemoryTransport, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { parse as parseYaml } from 'yaml';
import { registerRbookPromptHandlers } from '../src/server-prompts';

const SKILL_ROOT = path.resolve(__dirname, '../plugins/reasonbook/skills');
const COMMANDS = ['start', 'close-out', 'plan', 'build'];

async function connect(skillRoot?: string) {
  const server = new Server(
    { name: 'rbook-prompt-test', version: '1.0.0' },
    { capabilities: { prompts: {} } }
  );
  registerRbookPromptHandlers(server, skillRoot);
  const client = new Client({ name: 'prompt-supporting-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: () => client.close() };
}

describe('Reasonbook MCP prompts', () => {
  test('directory prompts expose only the six shipped chat skills and refuse full workflows', async () => {
    const saved = process.env.RBOOK_EDITION;
    process.env.RBOOK_EDITION = 'directory';
    const { client, close } = await connect();
    try {
      const commands = [
        'setup',
        'catch-up',
        'propose-decision',
        'capture-notes',
        'recall',
        'next-up',
      ];
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(
        commands.map((name) => `rbook-${name}`)
      );
      for (const name of commands) {
        const source = fs.readFileSync(
          path.resolve(__dirname, `../plugins/reasonbook-chat/skills/${name}/SKILL.md`),
          'utf8'
        );
        const body = source.replace(/^---\r?\n[\s\S]+?\r?\n---\r?\n/, '').trim();
        expect((await client.getPrompt({ name: `rbook-${name}` })).messages[0].content).toEqual({
          type: 'text',
          text: body,
        });
      }
      await expect(client.getPrompt({ name: 'rbook-build' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
      });
    } finally {
      await close();
      if (saved === undefined) delete process.env.RBOOK_EDITION;
      else process.env.RBOOK_EDITION = saved;
    }
  });

  test('a supporting client discovers all four commands and gets the exact shared skill body', async () => {
    const { client, close } = await connect();
    try {
      expect(client.getServerCapabilities()?.prompts).toEqual({});
      const listed = await client.listPrompts();
      expect(listed.prompts.map((prompt) => prompt.name)).toEqual(
        COMMANDS.map((command) => `rbook-${command}`)
      );
      for (const command of COMMANDS) {
        const source = fs.readFileSync(path.join(SKILL_ROOT, command, 'SKILL.md'), 'utf8');
        const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(source)!;
        const metadata = parseYaml(frontmatter[1]);
        const name = `rbook-${command}`;
        expect(listed.prompts.find((prompt) => prompt.name === name)).toEqual({
          name,
          description: metadata.description,
        });
        expect(await client.getPrompt({ name })).toEqual({
          description: metadata.description,
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: source.slice(frontmatter[0].length).trim() },
            },
          ],
        });
      }
    } finally {
      await close();
    }
  });

  test('unknown names and unsupported arguments fail instead of silently selecting a workflow', async () => {
    const { client, close } = await connect();
    try {
      await expect(client.getPrompt({ name: '../../agents.md' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringContaining('rbook-start'),
      });
      await expect(
        client.getPrompt({ name: 'rbook-build', arguments: { mission: 'wrong' } })
      ).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringContaining('does not accept arguments'),
      });
      expect(await client.getPrompt({ name: 'rbook-start', arguments: {} })).toHaveProperty(
        'messages'
      );
    } finally {
      await close();
    }
  });

  test.each([
    ['missing source', null],
    ['missing frontmatter', '# Start\nRead the project.'],
    ['wrong skill', '---\nname: build\ndescription: Start the project.\n---\nRead the project.'],
    ['missing description', '---\nname: start\n---\nRead the project.'],
    ['empty body', '---\nname: start\ndescription: Start the project.\n---\n'],
    ['invalid metadata', '---\nname: [\n---\nRead the project.'],
  ])(
    'an incomplete installation surfaces %s with a repair instruction',
    async (_reason, source) => {
      const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-prompt-skills-'));
      if (source !== null) {
        fs.mkdirSync(path.join(skillRoot, 'start'));
        fs.writeFileSync(path.join(skillRoot, 'start/SKILL.md'), source);
      }
      const { client, close } = await connect(skillRoot);
      try {
        await expect(client.getPrompt({ name: 'rbook-start' })).rejects.toMatchObject({
          code: ProtocolErrorCode.InternalError,
          message: expect.stringContaining('Reinstall @aquex/reasonbook'),
        });
        await expect(client.listPrompts()).rejects.toMatchObject({
          code: ProtocolErrorCode.InternalError,
        });
      } finally {
        await close();
        fs.rmSync(skillRoot, { recursive: true, force: true });
      }
    }
  );
});

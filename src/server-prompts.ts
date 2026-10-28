// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exposes portable Reasonbook commands as MCP prompts backed by the plugin's skill files.
// ABOUTME: Reads the installed sources so skill and prompt instructions cannot drift into copies.

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import { isDirectoryEdition } from './edition';

const COMMANDS = ['start', 'close-out', 'plan', 'build'] as const;
const DIRECTORY_COMMANDS = [
  'setup',
  'catch-up',
  'propose-decision',
  'capture-notes',
  'recall',
  'next-up',
] as const;
const SKILL_ROOT = path.resolve(__dirname, '../plugins/reasonbook/skills');
const DIRECTORY_SKILL_ROOT = path.resolve(__dirname, '../plugins/reasonbook-chat/skills');

function readSkill(command: string, skillRoot: string) {
  try {
    const source = fs.readFileSync(path.join(skillRoot, command, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(source);
    if (!frontmatter) throw new Error('Missing skill metadata');
    const metadata: unknown = parseYaml(frontmatter[1]);
    const body = source.slice(frontmatter[0].length).trim();
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('name' in metadata) ||
      metadata.name !== command ||
      !('description' in metadata) ||
      typeof metadata.description !== 'string' ||
      !metadata.description.trim() ||
      !body
    ) {
      throw new Error('Skill name, description or body is invalid');
    }
    return { name: `rbook-${command}`, description: metadata.description, body };
  } catch (error) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Cannot load rbook-${command}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Reinstall @aquex/reasonbook to restore its shared skill sources.'
    );
  }
}

export function registerRbookPromptHandlers(server: Server, skillRoot?: string): void {
  const directory = isDirectoryEdition();
  const commands: readonly string[] = directory ? DIRECTORY_COMMANDS : COMMANDS;
  const root = skillRoot ?? (directory ? DIRECTORY_SKILL_ROOT : SKILL_ROOT);
  server.setRequestHandler('prompts/list', async () => ({
    prompts: commands.map((command) => {
      const { name, description } = readSkill(command, root);
      return { name, description };
    }),
  }));

  server.setRequestHandler('prompts/get', async (request) => {
    const command = commands.find((candidate) => `rbook-${candidate}` === request.params.name);
    if (!command) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown prompt '${request.params.name}'. Use ${commands.map((name) => `rbook-${name}`).join(', ')}.`
      );
    }
    if (Object.keys(request.params.arguments ?? {}).length > 0) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `${request.params.name} does not accept arguments. Invoke it without arguments and describe the scope in the conversation.`
      );
    }
    const { description, body } = readSkill(command, root);
    return {
      description,
      messages: [{ role: 'user', content: { type: 'text', text: body } }],
    };
  });
}

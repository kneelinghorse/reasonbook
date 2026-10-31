// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook doctor's Codex reader: plugins and manual servers in ~/.codex/config.toml, and cached versions.
// ABOUTME: Read-only; a TOML form these rules cannot read makes the file unread, never silently clean.

import * as fs from 'fs';
import * as path from 'path';
import {
  fail,
  isObject,
  PLUGIN_NAME,
  readJson,
  readText,
  reasonbookServer,
  type Read,
  type ServerEntry,
} from './doctor-read';

export interface CodexState {
  readonly plugins: Read<Array<{ readonly name: string; readonly enabled: boolean }>>;
  readonly servers: Read<ServerEntry[]>;
  /** Version folders under ~/.codex/plugins/cache, each with the version its plugin.json gives. */
  readonly cached: ReadonlyArray<{ readonly name: string; readonly version: string | null }>;
}

const TOML_KEY = String.raw`("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)`;
const unquote = (key: string): string => key.replace(/^(["'])(.*)\1$/, '$2');

/**
 * The [table] blocks of a TOML file, read only for the keys doctor needs. A line that names the
 * plugins or servers in a shape these rules do not read (an inline table, a dotted key, a header
 * they cannot parse) makes the file unread, never silently clean.
 */
function tomlTables(text: string): Read<Array<{ header: string; body: string }>> {
  const tables: Array<{ header: string; body: string }> = [];
  const lines = text.split('\n');
  const unreadable = (i: number) =>
    fail(
      `~/.codex/config.toml line ${i + 1} names plugins or servers in a form doctor cannot read`
    );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
    const named = /^\s*\[*\s*(?:plugins|mcp_servers)\b/.test(line);
    const current = tables[tables.length - 1];
    if (header) tables.push({ header: header[1].trim(), body: '' });
    else if (named || /^\s*(?:plugins|mcp_servers)\s*[.=]/.test(line)) return unreadable(i);
    // Any other header ([[array]] tables among them) starts a table of its own, so its keys
    // are never read as the previous table's.
    else if (/^\s*\[/.test(line)) tables.push({ header: '', body: '' });
    // A key under a bare [plugins] or [mcp_servers] is an inline or dotted entry these rules
    // do not read, so the file is unread rather than clean.
    else if (current && /^(?:plugins|mcp_servers)$/.test(current.header) && /^\s*[^\s#]/.test(line))
      return unreadable(i);
    else if (current) current.body += `${line}\n`;
  }
  return { ok: true, value: tables };
}

function tableName(header: string, prefix: string): string | null {
  const match = new RegExp(`^${prefix}\\.${TOML_KEY}$`).exec(header.replace(/\s*\.\s*/g, '.'));
  return match ? unquote(match[1]) : null;
}

export function readCodex(home: string): CodexState {
  const text = readText(path.join(home, '.codex/config.toml'));
  const parsed = text.ok
    ? tomlTables(text.value)
    : text.missing
      ? ({ ok: true, value: [] } as const)
      : text;
  const cached: Array<{ name: string; version: string | null }> = [];
  const cache = path.join(home, '.codex/plugins/cache');
  for (const marketplace of safeList(cache))
    for (const plugin of safeList(path.join(cache, marketplace))) {
      if (!PLUGIN_NAME.test(`${plugin}@`)) continue;
      for (const folder of safeList(path.join(cache, marketplace, plugin))) {
        // Where the plugin launcher reads a version: the chat edition keeps its at the root.
        const version =
          ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json']
            .map((relative) => readJson(path.join(cache, marketplace, plugin, folder, relative)))
            .map((manifest) =>
              manifest.ok && isObject(manifest.value) && typeof manifest.value.version === 'string'
                ? manifest.value.version
                : null
            )
            .find((found) => found !== null) ?? null;
        cached.push({ name: `${plugin}@${marketplace}`, version });
      }
    }
  if (!parsed.ok) return { plugins: parsed, servers: parsed, cached };
  const value = (body: string, key: string) =>
    new RegExp(String.raw`^\s*${key}\s*=\s*(?:"([^"]*)"|'([^']*)')`, 'm')
      .exec(body)
      ?.slice(1)
      .find((part) => part !== undefined);
  const plugins = parsed.value
    .map((table) => ({ table, name: tableName(table.header, 'plugins') }))
    .filter(
      (entry): entry is { table: { header: string; body: string }; name: string } =>
        entry.name !== null
    )
    .map(({ table, name }) => ({ name, enabled: !/^\s*enabled\s*=\s*false\b/m.test(table.body) }))
    .filter((plugin) => PLUGIN_NAME.test(plugin.name));
  // A server turned off with enabled = false does not run, as a plugin's table reads.
  const codexServers = parsed.value
    .map((table) => ({ table, name: tableName(table.header, 'mcp_servers') }))
    .filter(
      (entry): entry is { table: { header: string; body: string }; name: string } =>
        entry.name !== null && !/^\s*enabled\s*=\s*false\b/m.test(entry.table.body)
    )
    .map(({ table, name }) => {
      const list = /^\s*args\s*=\s*\[([^\]]*)\]/m.exec(table.body)?.[1] ?? '';
      const args = [...list.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
      return reasonbookServer(name, { command: value(table.body, 'command'), args });
    })
    .filter((entry): entry is ServerEntry => entry !== null);
  return {
    plugins: { ok: true, value: plugins },
    servers: { ok: true, value: codexServers },
    cached,
  };
}

function safeList(directory: string): string[] {
  try {
    return fs.readdirSync(directory).filter((name) => !name.startsWith('.'));
  } catch {
    return [];
  }
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Who writes on this machine (ADR s96 §10): the author name the user set in config.json, and each
// ABOUTME: sign-in's dashboard identity, kept by the credential that fetched it so a write never calls the network.

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { resolveConfigDirectory } from './legacy-compat';

/** The Reasonbook user config, shared with the plugin hooks (`pluginServer`). */
export const USER_CONFIG_FILE = 'config.json';
/** Each sign-in's identity, as the dashboard returned it (H3), by credential. */
export const DASHBOARD_IDENTITY_FILE = 'dashboard-identity.json';

/** The longest author name kept; a name is a label, as git's user.name is. */
export const AUTHOR_NAME_MAX = 80;

/** ADR s96 §10's readings for a NULL author, which no one may take as a name. */
export const AUTHOR_BEFORE_RECORDED = 'before authors were recorded';
export const AUTHOR_NOT_RECORDED = 'author not recorded';

export interface DashboardIdentity {
  readonly userId: string;
  readonly username: string | null;
  /** The dashboard that answered; an identity is used only against the same one. */
  readonly baseUrl: string;
  readonly updatedAt: string;
}

function configFile(name: string, env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigDirectory(env), name);
}

/** The parsed file, or null when it does not exist; any other failure is the caller's to report. */
function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

const HIDDEN = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]$/u;
const JOINER = /^[\u200C\u200D]$/u;
const VARIATION_SELECTOR = /^[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;
/** A character a joiner or a variation selector may sit beside: neither ASCII nor a space. */
const JOINABLE = /^[^\p{ASCII}\s]$/u;
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
/** The blank Braille pattern is a symbol, so it would count as visible, but it shows as nothing. */
const BLANK_PATTERN = 0x2800;

/**
 * A name a person may go by: one line of text, trimmed, at most {@link AUTHOR_NAME_MAX}, with a
 * visible character. Since a name is shown beside other people's records, hidden characters are
 * refused: controls, line separators, format marks (zero-width spaces, direction overrides), the
 * other default-ignorables (fillers, tags) and the blank Braille pattern (s96-m13, #671). Two are
 * kept where a name needs them:
 * - a non-joiner or joiner between two non-ASCII characters, as in Persian spelling or a joined
 *   emoji; beside ASCII it only hides a difference ("der" + joiner + "ek" shows as "derek");
 * - a variation selector after a non-ASCII character, as an emoji's presentation.
 * A reading Reasonbook shows for an unnamed record is refused too, so no name can pass for one.
 */
export function validAuthorName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > AUTHOR_NAME_MAX) return null;
  const chars = [...trimmed];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i].codePointAt(0) === BLANK_PATTERN) return null;
    if (!HIDDEN.test(chars[i])) continue;
    const before = chars[i - 1] ?? '';
    const after = chars[i + 1] ?? '';
    if (JOINER.test(chars[i]) && JOINABLE.test(before) && JOINABLE.test(after)) continue;
    if (VARIATION_SELECTOR.test(chars[i]) && JOINABLE.test(before)) continue;
    return null;
  }
  if (!chars.some((char) => VISIBLE.test(char) && !HIDDEN.test(char))) return null;
  const folded = trimmed.toLowerCase();
  return folded === AUTHOR_BEFORE_RECORDED || folded === AUTHOR_NOT_RECORDED ? null : trimmed;
}

/** The author the user set with `reasonbook config author`, or null. A malformed config throws. */
export function readUserAuthor(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = configFile(USER_CONFIG_FILE, env);
  const value = readJson(file);
  if (value === null) return null;
  if (!isObject(value)) throw new Error(`${file} is not a JSON object.`);
  return typeof value.author === 'string' ? validAuthorName(value.author) : null;
}

/** Set the user's author name, keeping every other setting in the file. */
export function writeUserAuthor(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const author = validAuthorName(name);
  if (!author)
    throw new Error(
      `An author name is one line of 1 to ${AUTHOR_NAME_MAX} visible characters, without control characters or hidden marks (the joiners some scripts and emoji need are allowed), and not a reading Reasonbook shows for a record without one.`
    );
  const file = configFile(USER_CONFIG_FILE, env);
  const value = readJson(file) ?? {};
  if (!isObject(value))
    throw new Error(`${file} is not a JSON object; fix it before setting a name.`);
  writeJsonAtomic(file, { ...value, author });
  return author;
}

/** A credential's fingerprint: the identity file never holds a key. */
export function credentialFingerprint(credential: string): string {
  return createHash('sha256').update(credential).digest('hex').slice(0, 32);
}

/** Every identity kept, by credential fingerprint; a damaged file reads as empty, and is rewritten. */
function readIdentities(env: NodeJS.ProcessEnv): Record<string, DashboardIdentity> {
  let value: unknown;
  try {
    value = readJson(configFile(DASHBOARD_IDENTITY_FILE, env));
  } catch {
    return {};
  }
  const identities = isObject(value) && isObject(value.identities) ? value.identities : {};
  const kept: Record<string, DashboardIdentity> = {};
  for (const [fingerprint, entry] of Object.entries(identities)) {
    if (!isObject(entry) || typeof entry.userId !== 'string' || !entry.userId) continue;
    const username = typeof entry.username === 'string' ? validAuthorName(entry.username) : null;
    kept[fingerprint] = {
      userId: entry.userId,
      username,
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    };
  }
  return kept;
}

/**
 * The identity this credential signed in as, against this dashboard, or null. The dashboard
 * client drops a trailing slash from its address, so the comparison does too.
 */
export function readDashboardIdentity(
  credential: string,
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env
): DashboardIdentity | null {
  const identity = readIdentities(env)[credentialFingerprint(credential)];
  const address = (url: string) => url.replace(/\/+$/, '');
  return identity && address(identity.baseUrl) === address(baseUrl) ? identity : null;
}

/** Keep the identity the dashboard returned for this credential; written only when it changed. */
export function rememberDashboardIdentity(
  identity: { readonly userId: string; readonly username: string | null; readonly baseUrl: string },
  credential: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const identities = readIdentities(env);
  const fingerprint = credentialFingerprint(credential);
  const known = identities[fingerprint];
  const username = identity.username === null ? null : validAuthorName(identity.username);
  if (
    known &&
    known.userId === identity.userId &&
    known.username === username &&
    known.baseUrl === identity.baseUrl
  )
    return;
  identities[fingerprint] = { ...identity, username, updatedAt: new Date().toISOString() };
  writeJsonAtomic(configFile(DASHBOARD_IDENTITY_FILE, env), { identities });
}

/** Signing a credential out forgets who it was; with none left, the file goes. */
export function forgetDashboardIdentity(
  credential: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const identities = readIdentities(env);
  delete identities[credentialFingerprint(credential)];
  const file = configFile(DASHBOARD_IDENTITY_FILE, env);
  if (Object.keys(identities).length === 0) rmSync(file, { force: true });
  else writeJsonAtomic(file, { identities });
}

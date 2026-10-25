// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A copy over SSH (ADR s96 §7): BatchMode, a connect timeout and a shell-quoted remote command naming the node
// ABOUTME: and the binary there, since a non-login SSH command sees only the bare PATH, and the config folder there.

import { spawn } from 'child_process';
import { wirePeer, type WirePeer } from './record-wire';

/** How this copy reaches another machine's copy; the join records one for each member. */
export interface SshRoute {
  /** An ssh destination: `user@host`, or a host alias from the ssh config. */
  readonly host: string;
  /** The project folder on that machine. */
  readonly root: string;
  /** The node binary there, such as `/opt/homebrew/bin/node`. */
  readonly node?: string;
  /** The Reasonbook binary there: a path, or `reasonbook` on that machine's PATH. */
  readonly bin?: string;
  /** The config folder there, when it is not that account's default. */
  readonly configDir?: string;
}

export const SSH_CONNECT_TIMEOUT_S = 10;

/** One word for a POSIX shell, whatever it holds. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Why a route cannot be used, or null: an option-like host, or an empty field. */
export function routeProblem(route: SshRoute): string | null {
  if (!route.host || route.host.startsWith('-'))
    return 'the host must name a machine, and may not start with "-", which ssh reads as an option';
  if (!route.root) return 'the route names no project folder on that machine';
  return null;
}

/** The command the far end runs: a Reasonbook verb, through the node and binary the route names. */
export function remoteCommand(route: SshRoute, verb: readonly string[]): string {
  const words = [
    ...(route.node ? [route.node] : []),
    route.bin ?? 'reasonbook',
    ...verb,
    '--project-root',
    route.root,
  ].map(shellQuote);
  const env = route.configDir ? [`RBOOK_CONFIG_DIR=${shellQuote(route.configDir)}`] : [];
  return [...env, ...words].join(' ');
}

/**
 * ssh's arguments: no terminal, whatever a user's config asks (the wire is the command's stdin and
 * stdout), no password prompt, a bounded connect, then the destination and the command.
 */
export function sshArgs(route: SshRoute, verb: readonly string[]): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    route.host,
    remoteCommand(route, verb),
  ];
}

const oneLine = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200b]/g, '')
    .trim()
    .slice(0, 500);

/**
 * Open the far end of a route over SSH and wait for its banner. `ssh` names the client binary; a
 * test passes a stand-in that runs the command locally.
 */
export async function sshPeer(
  route: SshRoute,
  options: {
    readonly verb?: readonly string[];
    readonly ssh?: string;
    readonly timeoutMs?: number;
    /** s100-m01 (F7): this copy's hello, which the far end reads with the first request. */
    readonly nearHello?: Parameters<typeof wirePeer>[5];
  } = {}
): Promise<WirePeer> {
  const problem = routeProblem(route);
  if (problem) throw new Error(`The route cannot be used: ${problem}.`);
  // ssh is found on this process's PATH, as the caller sees it.
  const child = spawn(options.ssh ?? 'ssh', sshArgs(route, options.verb ?? ['sync', '--serve']), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const failed = new Promise<never>((_, reject) => {
    child.once('error', (error) =>
      reject(new Error(`ssh could not start: ${error.message}. Install OpenSSH, or name its path.`))
    );
  });
  try {
    return await Promise.race([
      wirePeer(
        `${route.host}:${route.root}`,
        child.stdout,
        child.stdin,
        () => {
          child.stdin.end();
        },
        options.timeoutMs,
        options.nearHello
      ),
      failed,
    ]);
  } catch (error) {
    child.kill();
    const said = oneLine(stderr);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${said ? ` (ssh said: ${said})` : ''}`
    );
  }
}

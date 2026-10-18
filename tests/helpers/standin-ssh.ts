// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A stand-in ssh for the shared record's tests: it skips ssh's options, logs the destination, and runs the
// ABOUTME: remote command on this machine with only the bare PATH a non-login SSH command sees (probe fact 34).
import fs from 'fs';
import path from 'path';
import type { SshRoute } from '../../src/tools/rbook/record-ssh';

/** The PATH a non-login SSH command sees on macOS: no Homebrew, no node, no reasonbook. */
export const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** The CLI from source, for a remote command that names it by absolute path. */
export const FAR_END = path.resolve(__dirname, 'sync-far-end.js');

/**
 * Write the stand-in into `dir` and return its path. Each run appends its destination to `log`, and
 * the command runs with a scratch HOME, so nothing reaches the person's own folders.
 */
export function standinSsh(dir: string): { readonly ssh: string; readonly log: string } {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'ssh.log');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const ssh = path.join(dir, 'ssh');
  fs.writeFileSync(
    ssh,
    [
      '#!/bin/sh',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o) shift 2 ;;',
      '    -T) shift ;;',
      '    *) break ;;',
      '  esac',
      'done',
      `printf '%s\\n' "$1" >> '${log}'`,
      'shift',
      `exec /usr/bin/env -i PATH=${BARE_PATH} HOME='${home}' /bin/sh -c "$1"`,
      '',
    ].join('\n')
  );
  fs.chmodSync(ssh, 0o755);
  return { ssh, log };
}

/** A route to a copy on another "machine" here: its own config folder, node and the CLI by path. */
export function routeTo(root: string, configDir: string, host = 'studio'): SshRoute {
  return { host, root, node: process.execPath, bin: FAR_END, configDir };
}

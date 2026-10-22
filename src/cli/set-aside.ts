// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Preview one gone copy's held cutoff and apply only with the person's explicit --yes.
// ABOUTME: Keep the cut under the copy's sync lock and surface the core authority/hosting refusals.
import { oneLine, parseArgs, resolveCliProject, type CliIo } from './core';
import { setAsideReplica } from '../tools/rbook/record-set-aside';
import { answered, storeOpener } from '../tools/rbook/record-sync';
import { withSyncLock } from '../tools/rbook/record-sync-trigger';
import { ReplicaRefusal } from '../tools/rbook/replica-identity';

const USAGE =
  'reasonbook set-aside --replica <id> [--yes] [--project-root <root>]: preview one gone copy; add --yes to record its cut.';

export async function runSetAside(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const replica = flags['replica'];
  if (
    !replica?.trim() ||
    replica === 'true' ||
    positional.length ||
    argv.filter((arg) => arg === '--replica' || arg.startsWith('--replica=')).length !== 1 ||
    (flags['yes'] !== undefined && flags['yes'] !== 'true')
  ) {
    io.stderr(USAGE);
    return 1;
  }
  const project = resolveCliProject({
    projectRootArg: flags['project-root'],
    env: io.env,
    cwd: io.cwd,
  });
  if (project.kind !== 'store') {
    io.stderr('reasonbook set-aside: no Reasonbook store found here; pass --project-root <root>.');
    return 1;
  }
  const result = await withSyncLock(project.dbPath, () =>
    answered(
      storeOpener(project.dbPath)((client) => {
        const applied = setAsideReplica(client, {
          replicaId: replica,
          dryRun: flags['yes'] !== 'true',
        });
        if (!applied.success) throw new ReplicaRefusal(applied.error!);
        return applied;
      })
    )
  );
  if (!result) {
    io.stderr(
      'A sync of this copy is running, so no copy was set aside. Ask again once it finishes.'
    );
    return 1;
  }
  if (!result.success || !result.data) {
    io.stderr(
      `${oneLine(result.error?.message ?? 'The copy could not be set aside.')}${result.error?.suggestion ? ` ${oneLine(result.error.suggestion)}` : ''}`
    );
    return 1;
  }
  const data = result.data;
  io.stdout(
    [
      `${oneLine(data.memberName)}: copy ${oneLine(data.replicaId)}, block ${data.block}, held cutoff ${data.cut}.`,
      `Last exchange: ${oneLine(data.lastExchangeAt ?? 'not observed')}.`,
      data.dryRun
        ? `Preview only; nothing changed. If this copy is gone, run reasonbook set-aside --replica ${oneLine(data.replicaId)} --yes.`
        : `${data.alreadySetAside ? 'Already set aside' : 'Set aside'}; later writes from this copy remain quarantined for its person to redo.`,
    ].join('\n') + '\n'
  );
  return 0;
}

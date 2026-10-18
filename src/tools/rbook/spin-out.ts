// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Move selected work between exact stores through durable copy and marking ledgers.
// ABOUTME: Retain source then target write reservations until verified source finalization commits.
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import Database from 'better-sqlite3';
import { mkdirSync, realpathSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { RbookToolResult } from './types';
import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { storeAt } from '../../intelligence/resolution-policy';
import { rbookProjectInit } from './rbook-project-init';
import { LEVEL_TIERS, levelName, levelOfTier, readRbookLine } from './rules-files';
import { readProjectTier } from './project-level';
import { allocateSpinOutIds, mapSpinOutRows } from './spin-out-mapping';
import { captureSpinOutManifest, fingerprintSpinOutPayload } from './spin-out-manifest';
import type { SpinOutCopyPlan, SpinOutSourceSnapshot } from './spin-out-types';
import {
  openSpinOut,
  prepareSpinOutStore,
  readSpinOutSnapshot,
  requireSpinOut,
  spinOutIdentity,
  spinOutSelection,
  validateSpinOutPair,
} from './spin-out-store';
import {
  operationKey,
  readSpinOutMetadata,
  reserveSpinOut,
  verifySpinOutBinding,
  verifySpinOutMarked,
  verifySpinOutReservations,
  verifySpinOutTarget,
  type SpinOutOperation,
} from './spin-out-ledger';
import { copySpinOutTarget } from './spin-out-copy';
import { isSharedStore } from './replica-identity';
import { markSpinOutSource } from './spin-out-mark';
import { spinOutParkedSprints, type SpinOutParkedSprint } from './spin-out-report';

export interface SpinOutOptions {
  readonly from: string;
  readonly to: string;
  readonly missionIds?: string[];
  readonly sprintId?: string;
  readonly decisionIds?: number[];
  readonly learningIds?: number[];
  readonly nextStepIds?: number[];
  readonly apply?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}
export interface SpinOutResult {
  readonly parkedSprints: readonly SpinOutParkedSprint[];
  readonly applied: boolean;
  readonly unchanged?: boolean;
  readonly operationId: string;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly counts: Record<string, number>;
  readonly identityGate?: string;
  readonly plan?: SpinOutCopyPlan;
  readonly backups?: string[];
  readonly followUp: string[];
}
async function backupSpinOut(root: string): Promise<string> {
  const dbPath = resolveRecordPaths(root).dbPath;
  const directory = path.join(path.dirname(dbPath), 'snapshots');
  mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, `spin-out-${randomUUID()}.sqlite`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  return destination;
}
/** No joint WAL commit: durable source reservations survive every target-first crash window. */
export async function spinOut(options: SpinOutOptions): Promise<RbookToolResult<SpinOutResult>> {
  let source: RbookDatabaseClient | undefined;
  let target: RbookDatabaseClient | undefined;
  let sourceLocked = false;
  let targetLocked = false;
  let operationId = 'unresolved';
  const sourceRoot = path.resolve(options.from);
  const targetRoot = path.resolve(options.to);
  const backups: string[] = [];
  const warnings: string[] = [];
  const followUp = [
    `Source ${sourceRoot}; target ${targetRoot}: each store uploads at its next MCP write.`,
    `Source ${sourceRoot}; target ${targetRoot}: no sprints are closed automatically; a target next step without a sprint is flagged idle after 42 days.`,
  ];
  const output = (
    snapshot: SpinOutSourceSnapshot,
    applied: boolean,
    extra: Partial<SpinOutResult> = {}
  ): RbookToolResult<SpinOutResult> => {
    const counts = { mission: 0, decision: 0, learning: 0, 'next-step': 0 };
    const keys = extra.plan
      ? extra.plan.rows.map((row) => row.source)
      : snapshot.rows.map((row) => row.key);
    for (const key of keys) counts[key.kind]++;
    const originalKeys = new Set(keys.map((key) => `${key.kind}:${key.id}`));
    const laterMatches = snapshot.rows.filter(
      (row) => !originalKeys.has(`${row.key.kind}:${row.key.id}`)
    ).length;
    if (extra.plan && laterMatches)
      followUp.push(
        `Source ${sourceRoot}; target ${targetRoot}: ${laterMatches} currently matched source rows were not in this completed operation and remain uncopied; counts describe the recorded copy only.`
      );
    const parkedSprints = spinOutParkedSprints(
      source!,
      snapshot,
      keys,
      !applied && !extra.unchanged
    );
    return createSuccess(
      { applied, operationId, sourceRoot, targetRoot, counts, parkedSprints, followUp, ...extra },
      warnings
    );
  };
  try {
    const selection = spinOutSelection(options);
    if (!storeAt(sourceRoot)?.hasDatabase)
      throw new Error('The exact source root has no Reasonbook database');
    if (realpathSync(sourceRoot) === realpathSync(targetRoot))
      throw new Error('Source and target root are the same');
    operationId = fingerprintSpinOutPayload({
      sourceRoot: realpathSync(sourceRoot),
      targetRoot: realpathSync(targetRoot),
      selection,
    });
    source = await openSpinOut(sourceRoot, true);
    let sourceIdentity = spinOutIdentity(source, sourceRoot);
    if (storeAt(targetRoot)?.hasDatabase) target = await openSpinOut(targetRoot, true);
    let targetIdentity = target ? spinOutIdentity(target, targetRoot) : undefined;
    validateSpinOutPair(sourceIdentity, targetIdentity, options.env);
    // s96-m01: a shared record's rows keep one id and one stable id on every copy (ADR s96 §2,
    // §3), and spin-out moves and renumbers rows, so it takes no part in a shared project.
    if (isSharedStore(source) || (target && isSharedStore(target)))
      throw new Error(
        'Spin-out moves records only between projects that are not shared; one of these is a copy of a shared record.'
      );
    let snapshot = readSpinOutSnapshot(source, sourceIdentity.projectId, selection);
    let operation = readSpinOutMetadata<SpinOutOperation>(source, operationKey(operationId));
    if (operation && targetIdentity)
      verifySpinOutBinding(operation, sourceIdentity, targetIdentity);
    if (operation && !targetIdentity)
      throw new Error(
        'Previously bound target database is now missing; preserve the source and restore/review the original target'
      );
    if (operation && target) {
      if (
        operation.phase !== 'marked' &&
        operation.manifest.hash !== captureSpinOutManifest(snapshot).hash
      )
        throw new Error('Reserved source scope changed; review both versions before recovery');
      if (!verifySpinOutTarget(target, operation))
        throw new Error(
          'Reserved retry lacks its committed target receipt; copying cannot be distinguished from an erased copy. Preserve both stores and review the snapshots.'
        );
    }
    if (!options.apply) {
      if (!target || !targetIdentity)
        return output(snapshot, false, { identityGate: 'target initialization required' });
      const mapping =
        operation?.mapping ??
        requireSpinOut(allocateSpinOutIds(target, snapshot), 'Preview ID allocation');
      const plan =
        operation?.plan ??
        requireSpinOut(
          mapSpinOutRows(snapshot, mapping, {
            operationId,
            source: sourceIdentity,
            target: targetIdentity,
            sourceUri: sourceIdentity.address,
            masterContextId: 'master_context',
          }),
          'Preview reference mapping'
        );
      return output(snapshot, false, {
        plan,
        ...(operation?.phase === 'marked' ? { unchanged: true } : {}),
      });
    }
    // Completed retries need no backup, migration or write; validate both ledgers and pointers.
    if (operation?.phase === 'marked' && target) {
      verifySpinOutMarked(source, operation);
      if (!verifySpinOutTarget(target, operation))
        throw new Error('Completed target ledger is missing');
      return output(snapshot, true, { unchanged: true, plan: operation.plan });
    }
    // s95-m06: a new target takes the source's level, so the moved sprints and missions read as
    // they did there; a Ledger's answers leave them out, so a Ledger's work goes to a Builder.
    const sourceLevel = levelOfTier(readProjectTier(source));
    const targetLevel = sourceLevel === 'ledger' ? 'builder' : sourceLevel;
    source.close();
    source = undefined;
    target?.close();
    target = undefined;
    backups.push(await backupSpinOut(sourceRoot));
    if (targetIdentity) backups.push(await backupSpinOut(targetRoot));
    else {
      // s95-m06: unless the target folder's agents file already names a level, read before init
      // writes one.
      const namedLevel = readRbookLine(targetRoot)?.level;
      requireSpinOut(
        await rbookProjectInit(
          {
            projectRoot: targetRoot,
            projectName: path.basename(targetRoot),
            ...(namedLevel ? {} : { projectType: LEVEL_TIERS[targetLevel] }),
          },
          { hooks: false, cliSource: 'explicit' }
        ),
        'Initialize exact target'
      );
      warnings.push(
        namedLevel
          ? `The new project at ${targetRoot} starts at the ${levelName(namedLevel)} level its folder's agents file names.`
          : `The new project at ${targetRoot} starts at the ${levelName(targetLevel)} level, ${sourceLevel === 'ledger' ? 'since a Ledger leaves out the sprints and missions it receives' : 'the level of the project the work came from'}.`
      );
      backups.push(await backupSpinOut(targetRoot));
    }
    source = await openSpinOut(sourceRoot, false);
    target = await openSpinOut(targetRoot, false);
    const reopenedSource = spinOutIdentity(source, sourceRoot);
    const reopenedTarget = spinOutIdentity(target, targetRoot);
    if (
      fingerprintSpinOutPayload(reopenedSource) !== fingerprintSpinOutPayload(sourceIdentity) ||
      (targetIdentity &&
        fingerprintSpinOutPayload(reopenedTarget) !== fingerprintSpinOutPayload(targetIdentity))
    )
      throw new Error('Store identity changed during backup/init; copying refused');
    sourceIdentity = reopenedSource;
    targetIdentity = reopenedTarget;
    validateSpinOutPair(sourceIdentity, targetIdentity, options.env);
    if (!operation) {
      prepareSpinOutStore(source, warnings);
      prepareSpinOutStore(target, warnings);
    }
    requireSpinOut(source.raw('BEGIN IMMEDIATE'), 'Reserve source');
    sourceLocked = true;
    snapshot = readSpinOutSnapshot(source, sourceIdentity.projectId, selection);
    const manifest = captureSpinOutManifest(snapshot);
    operation = readSpinOutMetadata<SpinOutOperation>(source, operationKey(operationId));
    let newlyReservedThisInvocation = false;
    requireSpinOut(target.raw('BEGIN IMMEDIATE'), 'Reserve target');
    targetLocked = true;
    if (operation) {
      verifySpinOutBinding(
        operation,
        spinOutIdentity(source, sourceRoot),
        spinOutIdentity(target, targetRoot)
      );
      verifySpinOutReservations(source, operation);
      if (operation.phase === 'marked') {
        verifySpinOutMarked(source, operation);
        if (!verifySpinOutTarget(target, operation))
          throw new Error('Completed target ledger is missing');
        requireSpinOut(target.raw('ROLLBACK'), 'Release unchanged target');
        targetLocked = false;
        requireSpinOut(source.raw('ROLLBACK'), 'Release unchanged source');
        sourceLocked = false;
        return output(snapshot, true, { unchanged: true, plan: operation.plan, backups });
      }
      if (operation.manifest.hash !== manifest.hash)
        throw new Error(
          'Reserved source scope or collision proof changed after reservation; review both versions before recovery'
        );
      const expectedPlan = requireSpinOut(
        mapSpinOutRows(snapshot, operation.mapping, {
          operationId,
          source: sourceIdentity,
          target: targetIdentity,
          sourceUri: sourceIdentity.address,
          masterContextId: 'master_context',
        }),
        'Revalidate reserved mapping'
      );
      if (fingerprintSpinOutPayload(expectedPlan) !== fingerprintSpinOutPayload(operation.plan))
        throw new Error('Reserved mapping plan changed; review source and target provenance');
    } else {
      if (readSpinOutMetadata(target, operationKey(operationId)))
        throw new Error(
          'Target operation exists without its source reservation; source replacement/recovery requires review'
        );
      const mapping = requireSpinOut(allocateSpinOutIds(target, snapshot), 'Allocate target IDs');
      const plan = requireSpinOut(
        mapSpinOutRows(snapshot, mapping, {
          operationId,
          source: sourceIdentity,
          target: targetIdentity,
          sourceUri: sourceIdentity.address,
          masterContextId: 'master_context',
        }),
        'Map source references'
      );
      operation = {
        operationId,
        source: sourceIdentity,
        target: targetIdentity,
        manifest,
        mapping,
        plan,
        phase: 'reserved',
      };
      reserveSpinOut(source, operation);
      newlyReservedThisInvocation = true;
      // Publish source reservations BEFORE target rows; retain target lock across this short gap.
      requireSpinOut(source.raw('COMMIT'), 'Publish source reservation');
      sourceLocked = false;
      requireSpinOut(target.raw('ROLLBACK'), 'Release allocation lock');
      targetLocked = false;
      requireSpinOut(source.raw('BEGIN IMMEDIATE'), 'Reacquire source');
      sourceLocked = true;
      requireSpinOut(target.raw('BEGIN IMMEDIATE'), 'Reacquire target');
      targetLocked = true;
      verifySpinOutReservations(source, operation);
      if (
        readSpinOutMetadata<SpinOutOperation>(source, operationKey(operationId))?.phase !==
        'reserved'
      )
        throw new Error('Source reservation advanced concurrently; retry the completed operation');
      if (
        captureSpinOutManifest(readSpinOutSnapshot(source, sourceIdentity.projectId, selection))
          .hash !== manifest.hash
      )
        throw new Error('Source changed after reservation; source finalization refused');
    }
    verifySpinOutBinding(
      operation,
      spinOutIdentity(source, sourceRoot),
      spinOutIdentity(target, targetRoot)
    );
    if (!verifySpinOutTarget(target, operation)) {
      // Only the creator of a newly published reservation may copy without a receipt.
      // A later invocation cannot distinguish a pre-copy crash from an erased target proof.
      if (!newlyReservedThisInvocation)
        throw new Error(
          'Existing reservation lacks a committed target receipt; source marking and recopying refused'
        );
      copySpinOutTarget(target, operation);
    }
    requireSpinOut(target.raw('COMMIT'), 'Commit verified target copy');
    targetLocked = false;
    requireSpinOut(target.raw('BEGIN IMMEDIATE'), 'Reacquire committed target');
    targetLocked = true;
    verifySpinOutBinding(
      operation,
      spinOutIdentity(source, sourceRoot),
      spinOutIdentity(target, targetRoot)
    );
    if (!verifySpinOutTarget(target, operation))
      throw new Error('Target ledger disappeared before source finalization');
    markSpinOutSource(source, operation);
    const receipt = output(snapshot, true, { plan: operation.plan, backups });
    requireSpinOut(source.raw('COMMIT'), 'Commit source marks');
    sourceLocked = false;
    requireSpinOut(target.raw('ROLLBACK'), 'Release verified target');
    targetLocked = false;
    return receipt;
  } catch (error) {
    for (const [client, locked, label] of [
      [target, targetLocked, 'target'],
      [source, sourceLocked, 'source'],
    ] as const)
      if (client && locked) {
        const rollback = client.raw('ROLLBACK');
        if (!rollback.success)
          warnings.push(`${label} rollback failed: ${rollback.error?.message}`);
      }
    const result = createError<SpinOutResult>({
      code: 'SPIN_OUT_REFUSED',
      message: `Spin-out ${operationId}: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: `Preserve source ${sourceRoot} and target ${targetRoot}. Inspect operation ${operationId} in both metadata ledgers and the reported database error; restore a verified backup or resolve the conflict before retrying the exact command. Never delete a reservation to force recopying.`,
    });
    if (backups.length) warnings.push(`Pre-write snapshots: ${backups.join(', ')}`);
    return { ...result, ...(warnings.length ? { warnings } : {}) };
  } finally {
    target?.close();
    source?.close();
  }
}

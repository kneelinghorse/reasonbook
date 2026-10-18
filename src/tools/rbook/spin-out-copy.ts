// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Insert a complete target union before repairing citations and sealing its target proof.
// ABOUTME: Fresh genesis stamps and exact required writes make ignored inserts fail the transaction.
import type { RbookDatabaseClient } from './client';
import { genesisColumns } from './genesis-columns';
import { repairRecordLinksBatch } from './record-links';
import { SPIN_OUT_ORIGIN_PREFIX } from './spin-out-types';
import { spinOutKeyText } from './spin-out-columns';
import { fingerprintSpinOutPayload } from './spin-out-manifest';
import { requireSpinOut } from './spin-out-store';
import { loadLinkInventory } from './record-link-store';
import { canonicalRecordFields, extractRecordLinkCandidates } from './record-link-extractor';
import {
  operationKey,
  verifySpinOutTarget,
  spinOutLinks,
  spinOutTargetProof,
  writeSpinOutMetadata,
  writeSpinOutRow,
  type SpinOutOperation,
  type SpinOutTargetLedger,
} from './spin-out-ledger';

export function copySpinOutTarget(client: RbookDatabaseClient, operation: SpinOutOperation): void {
  const before = spinOutLinks(client);
  const intended = new Map<string, Record<string, unknown>>();
  for (const row of [...operation.plan.rows].sort(
    (a, b) => Number(b.target.kind === 'mission') - Number(a.target.kind === 'mission')
  )) {
    const seq = requireSpinOut(
      client.getOne<{ next: number }>(
        `SELECT COALESCE(MAX(origin_seq),0)+1 AS next FROM ${row.table}`
      ),
      'Validate fresh origin sequence'
    );
    if (!seq || !Number.isSafeInteger(seq.next) || seq.next < 1)
      throw new Error(`Invalid ${row.table} origin sequence`);
    const genesis = genesisColumns(client, row.table, operation.target.projectId);
    // s96-m02: a column the row already carries is kept as copied: the stamp's author columns
    // would name whoever ran the spin-out, not the row's original author (ADR s96 §10).
    const stamp = genesis.columns
      .map((name, index) => [name, genesis.values[index]] as const)
      .filter(([name]) => !Object.prototype.hasOwnProperty.call(row.values, name));
    const columns = [...Object.keys(row.values), ...stamp.map(([name]) => name)];
    intended.set(spinOutKeyText(row.target), { ...row.values, ...Object.fromEntries(stamp) });
    writeSpinOutRow(
      client,
      `INSERT INTO ${row.table} (${columns.map((name) => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      [...Object.values(row.values), ...stamp.map(([, value]) => value)],
      `Copy ${spinOutKeyText(row.source)}`
    );
  }
  for (const edge of operation.plan.deferredSupersessions)
    writeSpinOutRow(
      client,
      'UPDATE strategic_decisions SET superseded_by=? WHERE id=?',
      [edge.supersededBy, edge.id],
      'Remap supersession'
    );
  for (const edge of operation.plan.deferredSupersessions)
    intended.get(`decision:${edge.id}`)!.superseded_by = edge.supersededBy;
  for (const edge of operation.plan.dependencies)
    writeSpinOutRow(
      client,
      'INSERT INTO mission_dependencies(from_id,to_id,type) VALUES(?,?,?)',
      [edge.from_id, edge.to_id, edge.type],
      'Copy dependency'
    );
  for (const provenance of operation.plan.provenance)
    writeSpinOutMetadata(
      client,
      `${SPIN_OUT_ORIGIN_PREFIX}${provenance.kind}:${provenance.targetId}`,
      provenance
    );
  const records = operation.mapping.flatMap(({ target }) =>
    target.kind === 'decision' || target.kind === 'learning'
      ? [{ kind: target.kind, id: target.id }]
      : []
  );
  requireSpinOut(repairRecordLinksBatch(client, records), 'Repair copied citation union');
  const after = spinOutLinks(client);
  const missionIds = operation.mapping
    .filter((entry) => entry.target.kind === 'mission')
    .map((entry) => entry.target.id);
  const dependencies = requireSpinOut(
    client.getMany(
      `SELECT from_id,to_id,type FROM mission_dependencies WHERE from_id IN (${missionIds.map(() => '?').join(',')}) OR to_id IN (${missionIds.map(() => '?').join(',')}) ORDER BY from_id,to_id,type`,
      [...missionIds, ...missionIds]
    ),
    'Verify intended dependencies'
  );
  const edgeOrder = (edges: readonly unknown[]) =>
    [...edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (
    fingerprintSpinOutPayload(edgeOrder(dependencies)) !==
    fingerprintSpinOutPayload(edgeOrder(operation.plan.dependencies))
  )
    throw new Error('Copied dependency payload differs from the intended mapping');
  for (const row of operation.plan.rows) {
    const stored = requireSpinOut(
      client.getOne<Record<string, unknown>>(`SELECT * FROM ${row.table} WHERE id=?`, [
        row.target.id,
      ]),
      'Verify intended target payload'
    );
    const expected = intended.get(spinOutKeyText(row.target))!;
    if (!stored || Object.keys(expected).some((key) => stored[key] !== expected[key]))
      throw new Error(
        `Copied target payload ${spinOutKeyText(row.target)} differs from the intended copy`
      );
  }
  if (records.length) {
    const inventory = loadLinkInventory(client, true);
    const sorted = (edges: readonly unknown[]) =>
      [...edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    for (const source of inventory.sources) {
      const expected = extractRecordLinkCandidates(
        canonicalRecordFields(source.kind, source.fields),
        source,
        inventory.identities,
        inventory.localProjectId
      ).links;
      const stored = after.filter(
        (row) => row.from_kind === source.kind && row.from_id === source.id
      );
      if (fingerprintSpinOutPayload(sorted(expected)) !== fingerprintSpinOutPayload(sorted(stored)))
        throw new Error(`Citation postcondition failed for ${source.kind}:${source.id}`);
    }
  }
  const candidates = new Map<string, { kind: string; id: number }>();
  for (const row of [...before, ...after])
    candidates.set(`${row.from_kind}:${row.from_id}`, {
      kind: String(row.from_kind),
      id: Number(row.from_id),
    });
  const linkSources = [...candidates.values()].filter(
    ({ kind, id }) =>
      fingerprintSpinOutPayload(
        before.filter((row) => row.from_kind === kind && row.from_id === id)
      ) !==
      fingerprintSpinOutPayload(after.filter((row) => row.from_kind === kind && row.from_id === id))
  );
  for (const row of records)
    if (!linkSources.some((r) => r.kind === row.kind && r.id === row.id)) linkSources.push(row);
  linkSources.sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);
  const ledger: SpinOutTargetLedger = {
    operation,
    phase: 'copied',
    linkSources,
    proof: spinOutTargetProof(client, operation, linkSources),
  };
  writeSpinOutMetadata(client, operationKey(operation.operationId), ledger);
  if (!verifySpinOutTarget(client, operation))
    throw new Error('Target copy ledger postcondition failed');
}

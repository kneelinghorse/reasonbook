// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Accounts for action-specific promises left to handlers by the dispatch design.
// ABOUTME: Each predicate row is paired with a real refusal so the census cannot hide an exemption.

import { executeMissionProtocolTool } from '../../../src/index';
import path from 'path';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { constraintKey, dispatchConstraints } from '../../helpers/dispatch-constraints';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';

const cases: Record<string, { args: Record<string, unknown>; code: string; remedy: RegExp }> = {
  'rbook_mission_transition /reason#description desc-required': {
    args: { action: 'block', missionId: 'm' },
    code: 'MISSING_PARAMETER',
    remedy: /reason/,
  },
  'rbook_decisions /content#description desc-required': {
    args: { action: 'record' },
    code: 'MISSING_PARAMETER',
    remedy: /content/,
  },
  'rbook_decisions /decisionIds#description desc-bound': {
    args: {
      action: 'batch_update',
      decisionIds: Array.from({ length: 101 }, (_, i) => i + 1),
      status: 'archived',
    },
    code: 'INVALID_PARAMETER',
    remedy: /100/,
  },
  'rbook_db /confirm#description desc-required': {
    args: { action: 'restore', snapshotId: 'snapshot' },
    code: 'INVALID_PARAMETER',
    remedy: /confirm/,
  },
  'rbook_learnings /acrossProjects#description desc-required': {
    args: { action: 'list', acrossProjects: true },
    code: 'MISSING_PARAMETER',
    remedy: /category/,
  },
  'rbook_feedback /feedbackId#description desc-required': {
    args: { action: 'triage' },
    code: 'MISSING_PARAMETER',
    remedy: /feedbackId/,
  },
  'rbook_auth /keyId#description desc-required': {
    args: { action: 'logout' },
    code: 'MISSING_PARAMETER',
    remedy: /keyId/,
  },
};
const rows = dispatchConstraints().filter((row) => row.kind.startsWith('desc-'));
let project: SeededRbookProject;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-description-');
});
afterEach(async () => {
  CredentialStore.resetInstance();
  await project.cleanup();
});

it('covers every description promise exactly once', () => {
  expect(rows).toHaveLength(7);
  expect(rows.map(constraintKey).sort()).toEqual(Object.keys(cases).sort());
});

it.each(rows.map((row) => [constraintKey(row), row] as const))(
  '%s is refused by its handler',
  async (key, row) => {
    const specimen = cases[key];
    if (row.tool === 'rbook_auth') {
      const store = await CredentialStore.create({
        configDir: path.join(project.projectRoot, 'credentials'),
      });
      const now = new Date().toISOString();
      for (const id of ['login-a', 'login-b'])
        await store.upsertUserScopedKey(id, {
          key: `cmk_${id}`,
          label: id,
          issuedAt: now,
          lastUsedAt: now,
        });
    }
    const result = await executeMissionProtocolTool(
      row.tool,
      { ...specimen.args, projectRoot: project.projectRoot },
      {} as never
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: specimen.code } });
    const error = (result.structuredContent as { error: { suggestion: string } }).error;
    expect(error.suggestion).toMatch(specimen.remedy);
    if (row.tool === 'rbook_auth') {
      // Ambiguous logout must not choose or revoke either login on the operator's behalf.
      expect(Object.keys(await CredentialStore.getInstance().listUserScopedKeys()).sort()).toEqual([
        'login-a',
        'login-b',
      ]);
    }
  }
);

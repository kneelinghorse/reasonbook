// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Preserve documented inputs when consolidated schemas become the dispatch boundary.
// ABOUTME: Keep existing nested clear operations and unconstrained JSON values available.

import { rbookMissionSchema } from '../../../src/tools/rbook/rbook-mission';
import { rbookProjectSchema } from '../../../src/tools/rbook/rbook-project';
import { rbookDecisionsSchema } from '../../../src/tools/rbook/rbook-decisions';
import { rbookFeedbackSchema } from '../../../src/tools/rbook/rbook-feedback';
import { rbookContextSchema } from '../../../src/tools/rbook/rbook-context';

describe('consolidated input schemas preserve supported calls', () => {
  it.each([
    'objective',
    'context',
    'successCriteria',
    'deliverables',
    'referenceDocs',
    'domainFields',
    'notes',
    'metadata',
  ])('allows the existing mission fields.%s clear operation', (field) => {
    expect(
      rbookMissionSchema.safeParse({
        action: 'update',
        missionId: 's1-m01',
        fields: { [field]: null },
      }).success
    ).toBe(true);
  });

  it.each(['name', 'status'])(
    'does not turn invalid fields.%s null into a clear operation',
    (field) => {
      expect(
        rbookMissionSchema.safeParse({
          action: 'update',
          missionId: 's1-m01',
          fields: { [field]: null },
        }).success
      ).toBe(false);
    }
  );

  it('leaves initial sprint and mission requiredness to the existing init handler', () => {
    expect(
      rbookProjectSchema.safeParse({ action: 'init', initialSprint: {}, initialMissions: [{}] })
        .success
    ).toBe(true);
  });

  it('retains the initial mission null sprint meaning unscheduled', () => {
    expect(
      rbookProjectSchema.safeParse({
        action: 'init',
        initialMissions: [{ id: 'm1', name: 'First', sprintId: null }],
      }).success
    ).toBe(true);
  });

  it('does not invent a published evidence minimum length or feedback minimum count', () => {
    expect(
      rbookDecisionsSchema.safeParse({ action: 'record', evidence: [{ type: '', id: '' }] }).success
    ).toBe(true);
    expect(rbookFeedbackSchema.safeParse({ action: 'resolve', feedbackIds: [] }).success).toBe(
      true
    );
  });

  it('requires the field-update value key while accepting all six published JSON types', () => {
    expect(
      rbookContextSchema.safeParse({ action: 'update', fieldUpdates: [{ path: 'description' }] })
        .success
    ).toBe(false);
    for (const value of ['text', 3, true, {}, [], null]) {
      expect(
        rbookContextSchema.safeParse({
          action: 'update',
          fieldUpdates: [{ path: 'description', value }],
        }).success
      ).toBe(true);
    }
  });
});

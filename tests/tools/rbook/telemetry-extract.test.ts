// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Telemetry keeps record namespaces and successful uses distinct from text and incidental IDs.
// ABOUTME: These contracts prevent same-number learnings, failed writes and unrelated rows inflating G1.

import { returnedIds, citedIds, usedIds } from '../../../src/tools/rbook/telemetry-extract';

describe('typed telemetry extraction', () => {
  it('counts a cited decision only after reopen actually writes its reason', () => {
    const args = { action: 'reopen', missionId: 'finished', reason: 'Apply decision #21.' };
    expect(usedIds('rbook_mission_transition', args, 'write', { success: true })).toEqual(['d:21']);
    expect(usedIds('rbook_mission_transition', args, 'write', { success: false })).toEqual([]);
  });

  it('keeps pulled foreign records out of the local typed namespace on every response shape', () => {
    const remote = { id: 7, projectId: 'another-project' };
    expect(returnedIds('rbook_decisions', { action: 'show' }, remote)).toEqual([]);
    expect(
      usedIds('rbook_decisions', { action: 'show', decisionId: 7 }, 'read', {
        success: true,
        data: remote,
      })
    ).toEqual([]);
    expect(
      returnedIds(
        'rbook_context',
        { action: 'search' },
        { localProjectId: 'here', results: [{ ...remote, type: 'decision' }] }
      )
    ).toEqual([]);
    expect(returnedIds('rbook_review', {}, { recentDecisions: [remote] })).toEqual([]);
  });

  it('observes both decision-review namespaces and constraint/learning receipts', () => {
    expect(
      returnedIds(
        'rbook_decisions',
        { action: 'review' },
        { decisions: [{ id: 1 }], learnings: [{ id: 1 }] }
      )
    ).toEqual(['d:1', 'l:1']);
    expect(
      returnedIds('rbook_context', { action: 'constraints' }, { reviewItems: [{ id: 2 }] })
    ).toEqual(['c:2']);
    expect(returnedIds('rbook_learnings', { action: 'reaffirm' }, { learningId: 3 })).toEqual([
      'l:3',
    ]);
  });

  // s100-m03: a next-step capture returns its row's id, which a later call may cite.
  it('observes the next-step id a capture returns, beside a decision capture', () => {
    expect(returnedIds('rbook_session', { action: 'capture' }, { nextStepId: 4 })).toEqual(['n:4']);
    expect(returnedIds('rbook_session', { action: 'capture' }, { decisionId: 5 })).toEqual(['d:5']);
  });
  it('counts receipt-confirmed actions, excluding unmatched IDs and review-only actions', () => {
    expect(
      usedIds('rbook_decisions', { action: 'batch_update', decisionIds: [1, 2, 3] }, 'write', {
        success: true,
        data: { updated: 1, notFound: [2], alreadyInStatus: [3], failed: [], lookupFailed: [] },
      })
    ).toEqual(['d:1']);
    expect(
      usedIds(
        'rbook_context',
        { action: 'next_steps', nextStepAction: 'complete', nextStepIds: [1, 2] },
        'write',
        {
          success: true,
          data: { affected: 1, unmatchedIds: [2] },
        }
      )
    ).toEqual(['n:1']);
    expect(
      usedIds(
        'rbook_context',
        { action: 'constraints', constraintAction: 'list', constraintIds: [1] },
        'write',
        {
          success: true,
          data: { affected: 1, items: [{ id: 1 }] },
        }
      )
    ).toEqual([]);
    expect(
      usedIds(
        'rbook_context',
        { action: 'constraints', constraintAction: 'reaffirm', constraintId: 7 },
        'write',
        {
          success: true,
          data: { affected: 1, constraintId: 7 },
        }
      )
    ).toEqual(['c:7']);
  });
  it('types mixed results and ignores unrelated mission, session and feedback IDs', () => {
    expect(
      returnedIds(
        'rbook_context',
        { action: 'search' },
        {
          results: [
            { type: 'decision', id: 7 },
            { type: 'learning', id: 7 },
            { type: 'mission', id: 42 },
          ],
        }
      )
    ).toEqual(['d:7', 'l:7']);
    expect(
      returnedIds(
        'rbook_review',
        {},
        {
          recentDecisions: [{ id: 8 }],
          recentLearnings: [{ id: 8 }],
          workQueue: { current: { top: [{ id: 9 }] } },
          next_actions: [{ id: 10 }],
        }
      )
    ).toEqual(['d:8', 'l:8']);
    expect(returnedIds('rbook_feedback', { action: 'list' }, { items: [{ id: 12 }] })).toEqual([]);
  });

  it('reads citations with explicit namespaces; bare #N means decision only', () => {
    expect(
      citedIds({
        supersedes: [2],
        citesLearningIds: [3],
        content:
          'Use learning #7, constraint #8, next-step #9 and decision #10; #11 follows l:12 and d:13.',
      })
    ).toEqual(['d:2', 'l:3', 'l:7', 'c:8', 'n:9', 'd:10', 'd:11', 'l:12', 'd:13']);
    expect(
      citedIds({ query: '#66', projectRoot: '/private/#77', content: 'No citation.' })
    ).toEqual([]);
  });

  it('counts successful explicit shows and writes, never refusals or list/query mentions', () => {
    expect(
      usedIds('rbook_learnings', { action: 'show', learningId: 7 }, 'read', {
        success: true,
        data: { id: 7 },
      })
    ).toEqual(['l:7']);
    expect(
      usedIds('rbook_decisions', { action: 'record', content: '#7' }, 'write', { success: false })
    ).toEqual([]);
    expect(
      usedIds('rbook_session', { action: 'capture', content: '#7' }, 'write', {
        success: true,
        data: { writeFailures: [{}] },
      })
    ).toEqual([]);
    expect(
      usedIds('rbook_decisions', { action: 'search', query: '#7' }, 'read', { success: true })
    ).toEqual([]);
  });

  it('counts reasoning and typed evidence while keeping incidental numbers out of use', () => {
    expect(
      citedIds({
        context: 'Apply decision #21.',
        consequences: 'Retains learning #22.',
        alternatives: ['Rejected next-step #23.', { ignored: '#99' }],
        evidence: [
          { type: 'decision', id: '24' },
          { type: 'learning', id: '25' },
          { type: 'next-step', id: '26' },
          { type: 'mission', id: '27' },
          { type: 'url', id: 'https://example.com/#28' },
          { type: 'decision', id: '-1' },
          { type: 'decision', id: '2.5' },
          { type: 'decision', id: 'private #29' },
        ],
        deciders: ['person #30'],
        objective: 'Outside the ratified citation fields #31',
      })
    ).toEqual(['d:24', 'l:25', 'n:26', 'd:21', 'l:22', 'n:23']);
    expect(
      usedIds('rbook_decisions', { action: 'record', context: '#21' }, 'write', {
        success: false,
      })
    ).toEqual([]);
  });

  it('handles show/list/search/next steps and constrains numeric IDs', () => {
    expect(returnedIds('rbook_decisions', { action: 'show' }, { id: 5 })).toEqual(['d:5']);
    expect(
      returnedIds(
        'rbook_learnings',
        { action: 'list' },
        { learnings: [{ id: 5 }, { id: 'private text' }] }
      )
    ).toEqual(['l:5']);
    expect(returnedIds('rbook_context', { action: 'next_steps' }, { items: [{ id: 5 }] })).toEqual([
      'n:5',
    ]);
    expect(returnedIds('rbook_context', { action: 'constraints' }, { items: [{ id: 5 }] })).toEqual(
      ['c:5']
    );
    expect(citedIds({ supersedes: [-1, 0, 1.5, 'secret', 4] })).toEqual(['d:4']);
  });
});

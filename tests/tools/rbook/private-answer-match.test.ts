// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Checks the evidence needed before a private link can answer a pending decision.
// ABOUTME: Similar vocabulary, different targets, and later corrections must leave the choice open.

import { privateAnswerMatches } from '../../../src/tools/rbook/private-answer-match';

const release = 'Ship a docs-only 2.7.3 as an exception to the release pause.';
const round = 's22-m04 runs a fifth critic round.';
const timer = 'The scheduled dependency check is a script on a 12-hour timer.';

it('compares the entire unqualified affirmative choice at either age', () => {
  const choice =
    'Keep the monthly newsletter subscription report in the shared editorial planning folder.';
  for (const newer of [true, false]) {
    expect(privateAnswerMatches(choice, choice.replace(/ /g, '   '), newer)).toBe(true);
    for (const almost of [
      choice.replace('in the shared', 'except in the shared'),
      choice + ' Apply it only on Fridays.',
      choice.replace('monthly', 'weekly'),
    ])
      expect(privateAnswerMatches(choice, almost, newer)).toBe(false);
  }
  expect(privateAnswerMatches(' ', ' ', true)).toBe(false);
});

it.each([
  [release, 'No docs-only 2.7.3 ships as an exception to the release pause.'],
  [round, 's22-m04 runs no fifth critic round.'],
  [timer, 'The scheduled dependency check is dropped.'],
  [
    timer,
    'The scheduled dependency check is dropped: the client upgrades to a new library release when Morgan has time to start a session, and a wait of weeks or of two releases before that is accepted, not an issue to resolve.',
  ],
])('accepts an explicit rejection only when it follows the proposal', (draft, answer) => {
  expect(privateAnswerMatches(draft, answer, true)).toBe(true);
  expect(privateAnswerMatches(draft, answer, false)).toBe(false);
});

it.each([
  [release, 'No docs-only 2.7.30 ships as an exception to the release pause.'],
  [release, 'No docs-only 2.7.3-beta ships as an exception to the release pause.'],
  [release, 'No docs-only 2.7.3 ships as an exception to the testing pause.'],
  [release, 'No docs-only 2.7.3 ships if maintainers are away.'],
  [release, 'No docs-only 2.7.3 ships for now.'],
  [release, '“No docs-only 2.7.3 ships,” reads the example.'],
  [release, 'No docs-only 2.7.3 ships. Correction: ship that same release on Monday.'],
  [release, 'No docs-only 2.7.3 ships: package it for immediate publication.'],
  [
    release,
    'No docs-only 2.7.3 ships: the wording is corrected in the next release. Ship it anyway.',
  ],
  [release, 'No docs-only 2.7.3 ships: the wording is corrected in the next release if ready.'],
  ['Do not ship a docs-only 2.7.3.', 'No docs-only 2.7.3 ships.'],
  ['Review a docs-only 2.7.3 as an exception to the release pause.', 'No docs-only 2.7.3 ships.'],
  [round, 's22-m040 runs no fifth critic round.'],
  [
    's22-m04 runs a fifth critic round. Correction: use the fourth round only.',
    's22-m04 runs no fifth critic round.',
  ],
  ['Ship a docs-only 2.7.3? This was a suggestion.', 'No docs-only 2.7.3 ships.'],
  ['Ship a docs-only 2.7.3. Correction: abandon the release.', 'No docs-only 2.7.3 ships.'],
  ['Ship a docs-only 2.7.3 or postpone the feature release.', 'No docs-only 2.7.3 ships.'],
  [
    round,
    "s22-m04 runs no fifth critic round, by the operator's word to start another round: the changes are committed with their tests, verified by metrics rather than another review, and m04's closing checks pass to the next agent.",
  ],
  [round, 's22-m04 runs no fourth critic round.'],
  [round, 's22-m04 runs no fifth testing round.'],
  [round, 's22-m04 runs no fifth critic round, unless reviewers disagree.'],
  [round, 's22-m04 runs no fifth critic round. Run it after the audit.'],
  [
    's22-m04 quotes the example: “run a fifth critic round”.',
    's22-m04 runs no fifth critic round.',
  ],
  [timer, 'The scheduled performance check is dropped.'],
  [timer, 'The scheduled dependency check is postponed.'],
  [timer, 'The scheduled dependency check is dropped for now.'],
  [timer, 'The scheduled dependency check is not dropped.'],
  [timer, 'The scheduled dependency check is dropped. Reinstate it when tickets accumulate.'],
  [timer, 'The scheduled dependency check is dropped: the work is automated on a shorter timer.'],
  [
    'The scheduled dependency check is a manual review.',
    'The scheduled dependency check is dropped.',
  ],
])('leaves qualified, conflicting or merely topical text pending (%s / %s)', (draft, answer) => {
  expect(privateAnswerMatches(draft, answer, true)).toBe(false);
});

it.each([
  'Someone suggested adopting the release schedule.',
  'Should we adopt the release schedule?',
  'Maybe adopt the release schedule.',
  '"Adopt the release schedule."',
  'Adopt the release schedule. Correction: leave it open for discussion.',
])('matching a quotation or undecided question does not make it an adopted choice', (words) => {
  expect(privateAnswerMatches(words, words, true)).toBe(false);
});

it('keeps a deliverable or mission named next to the actual target from changing the meaning', () => {
  expect(
    privateAnswerMatches('Ship a docs-only 2.7.3 announcement.', 'No docs-only 2.7.3 ships.', true)
  ).toBe(false);
  expect(
    privateAnswerMatches(
      's22-m04 folds the fixes. For s22-m05 we need a different revision. A fresh critic verifies that commit, as a fifth, verification-only round.',
      's22-m04 runs no fifth critic round.',
      true
    )
  ).toBe(false);
});

it.each([
  'Keep the change log only if the curator accepts it.',
  'Keep the change log pending approval.',
  'Use the blue layout. Continue using the green layout.',
  'Record the selection but wait for confirmation.',
])('requires one unconditional affirmative statement across the entire string', (text) => {
  expect(privateAnswerMatches(text, text, true)).toBe(false);
});

it('admits only the supported disposition after a scoped release proposal', () => {
  expect(
    privateAnswerMatches(release + ' Withdraw the proposal.', 'No docs-only 2.7.3 ships.', true)
  ).toBe(false);
  expect(
    privateAnswerMatches(
      release + ' A different deliverable was approved.',
      'No docs-only 2.7.3 ships.',
      true
    )
  ).toBe(false);
});

it('requires the account of completed work to be a single clause', () => {
  const explanation =
    ", by the operator's word: the plan changed. Start the fifth critic round. Changes are committed with their tests, verified by metrics rather than another review, and m04's closing checks pass to the next agent.";
  expect(
    privateAnswerMatches(round, 's22-m04 runs no fifth critic round' + explanation, true)
  ).toBe(false);
});

it.each([
  'for now',
  'for the time being',
  'at present',
  'as long as the queue stays empty',
  'on condition that the job runs',
  'tentatively',
  'provisionally',
  'with reservations',
])('considers a provisional disposition outside the affirmative grammar: %s', (condition) => {
  const text = 'Keep the report ' + condition + '.';
  expect(privateAnswerMatches(text, text, true)).toBe(false);
});

it.each([
  'Retain the daily status report.',
  'Store the export in the shared folder.',
  'Keep the import report alongside the source data for the next run.',
])('recognizes supported artifact choices as a whole', (choice) => {
  for (const newer of [true, false]) {
    expect(privateAnswerMatches(choice, choice, newer)).toBe(true);
    const qualified = choice.replace('the ', 'the provisional ');
    expect(privateAnswerMatches(qualified, qualified, newer)).toBe(false);
  }
});

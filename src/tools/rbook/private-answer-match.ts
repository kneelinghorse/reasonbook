// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Checks whether a recorded choice answers the whole proposal in the private settle command.
// ABOUTME: Only three explicit forms of rejection qualify; Stop keeps its historical coverage rules.

import { ANSWER_COVERAGE, draftCoverage, recordStatesDraft } from './draft-subject';
import { SETTLE_AFTER_FLOOR } from './draft-settle';

const MISSION = /^s\d+-m\d+\b/;
const VERSION = '(\\d+\\.\\d+\\.\\d+)';
const SHIP = new RegExp('^ship a docs-only ' + VERSION + '(?= |[.:] |[.]?$)');
const NO_SHIP = new RegExp('^no docs-only ' + VERSION + ' ships\\b');
const PAUSE = /^ as (?:the one|an) exception to (the (?:[a-z-]+ ){1,3}pause)(?=[:.]|$)/;
const TIMER =
  /^(the scheduled (?:[a-z-]+ ){1,3}check) is (?:a|an) (?:plain )?script on a \d+[- ](?:minute|hour|day) timer\b/;

// Accept a single instruction to keep a named artifact. Every slot has a closed vocabulary:
// unknown objects and modifiers take the ordinary question path, even if both texts use them.
const ARTIFACT =
  'the (?:(?:daily|weekly|monthly) )?(?:(?:import|status|subscription|newsletter) ){0,2}(?:report|export|file)';
const LOCATION =
  '(?: in the (?:shared )?(?:editorial )?(?:planning )?folder| alongside the source data)';
const KEEP_ARTIFACT = new RegExp(
  '^(?:keep|retain|store) ' + ARTIFACT + LOCATION + '?(?: for the next run)?\\.?$',
  'i'
);

// A release proposal may explain the wording correction and its test gate. Each is one
// sentence. A dotted document address is data, so it cannot introduce another clause.
function releaseExplanation(tail: string): boolean {
  if (!tail || tail === '.') return true;
  const text = tail.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[a-z0-9/-]+\b/g, 'document');
  const [reason, timing, ...extra] = text.replace(/\.$/, '').split(/\.\s+/);
  if (
    extra.length ||
    !/^: it (?:corrects|updates) the [a-z' -]{1,70}(?:wording|documentation|disclosure)(?:, because [a-z0-9' -]{1,100})?$/.test(
      reason
    )
  )
    return false;
  return (
    timing === undefined ||
    /^it (?:ships|goes out) once the [a-z-]+ fix lets the full suite pass(?: on [a-z -]+)?(?:, now that [a-z -]+ work(?:s)? here)?$/.test(
      timing
    )
  );
}

// The long-form proposals below can have explanatory text but cannot withdraw, reverse or
// relocate the operative choice there. Unknown sentence structures take the normal question path.
const RETRACTION =
  /\b(?:abandon(?:s|ed)?|cancel(?:s|led)?|withdraw(?:s|n)?|withdrawal|retract(?:s|ed)?|obsolete|supersed(?:es|ed)|overrid(?:e|es)|in lieu of|alternatively|instead|correction|do not|must not|never mind)\b/;

// A private link is optional. Decline unknown continuations instead of treating the opening
// sentence alone as the recorded choice. Each accepted tail describes the disposition of the
// deferred wording, a human-triggered replacement, or already committed and verified work.
function releaseRejected(draft: string, answer: string): boolean {
  const proposed = SHIP.exec(draft);
  const rejected = NO_SHIP.exec(answer);
  if (!proposed || !rejected || proposed[1] !== rejected[1]) return false;
  // Require the release itself to be the direct object. Sending its notes or announcing it is a different action.
  const remainder = draft.slice(proposed[0].length);
  const proposedScope = PAUSE.exec(remainder);
  if (!releaseExplanation(remainder.slice(proposedScope?.[0].length ?? 0))) return false;
  let tail = answer.slice(rejected[0].length);
  const scope = PAUSE.exec(tail);
  if (scope) {
    if (proposedScope?.[1] !== scope[1]) return false;
    tail = tail.slice(scope[0].length);
  }
  if (tail === '') return true;
  return /^: the (?:[a-z'-]+ ){0,8}(?:wording|documentation|disclosure|copy) (?:is|will be) (?:updated|corrected|published) in the next release(?: that (?:carries|includes) other work)?$/.test(
    tail
  );
}

function checkDropped(draft: string, answer: string): boolean {
  const timer = TIMER.exec(draft);
  if (!timer) return false;
  const specification = draft.slice(timer[0].length).replace(/\.$/, '');
  if (
    specification &&
    !/^ that never calls [a-z -]+; on a new (?:complete )?release it [a-z0-9 ,'-]+$/.test(
      specification
    )
  )
    return false;
  const head = timer[1] + ' is dropped';
  if (!answer.startsWith(head)) return false;
  const tail = answer.slice(head.length);
  if (!tail || /^: (?:use|keep) a manual check(?: instead)?$/.test(tail)) return true;
  // A switch to a session someone opens can also accept the resulting delay. Read the whole
  // delay clause: it must not order a replacement timer or reinstate the same check.
  const [manual, delay, qualification, ...extra] = tail.split(', ');
  if (
    extra.length ||
    !/^: the [a-z-]+ (?:moves|upgrades) to a new (?:[a-z-]+ ){0,5}release when [a-z-]+ has time to (?:open|start) a session$/.test(
      manual
    )
  )
    return false;
  return (
    delay === undefined ||
    (/^and a wait of (?:days|weeks|months|releases|one|two|three|four|or|of)(?: (?:days|weeks|months|releases|one|two|three|four|or|of)){0,14} before that is accepted$/.test(
      delay
    ) &&
      (qualification === undefined ||
        /^not (?:a|an) (?:defect|issue|error)(?: to (?:fix|resolve))?$/.test(qualification)))
  );
}

function roundRejected(draft: string, answer: string): boolean {
  const mission = MISSION.exec(draft)?.[0];
  if (!mission || draft.match(/\bs\d+-m\d+\b/g)?.some((id) => id !== mission)) return false;
  const proposed = draft.slice(mission.length);
  // Either the mission directly runs the round, or a subsequent operative sentence assigns
  // verification of that mission's commit to a fresh critic for a fifth round.
  const simple = proposed.replace(/\.$/, '') === ' runs a fifth critic round';
  if (!simple) {
    const sentences = proposed
      .replace(/`[./_-]+`/g, 'path')
      .replace(/\.$/, '')
      .split('. ');
    const [change, review, close] = sentences;
    if (
      sentences.length !== 3 ||
      !/^ folds round [1-4]'s (?:finding|fix)[a-z0-9 ,()'-]*$/.test(change) ||
      !/^a fresh critic verifies (?:only )?that commit, as a fifth, verification-only round(?: beyond the [a-z -]+ that the [a-z -]+ \(decision #\d+\) allows)?$/.test(
        review
      ) ||
      close !== mission.split('-')[1] + ' closes only if it passes'
    )
      return false;
  }
  const head = mission + ' runs no fifth critic round';
  if (!answer.startsWith(head)) return false;
  const tail = answer.slice(head.length);
  if (!tail) return true;
  // An attribution followed by completed work and a handoff can explain the refusal. Plain
  // free text after the refusal is deliberately insufficient. The short mission must agree.
  const attribution =
    /^, by the operator's word(?: on \d{4}-\d{2}-\d{2})?(?: to (?:take|choose) the (?:shortest|simplest) path that keeps (?:the )?[a-z -]{1,30} (?:sound|reliable))?: /;
  const evidence = attribution.exec(tail);
  if (
    !evidence ||
    /\b(?:round|review|critic|start|run|hold|schedule|commission|undertake|reverse|cancel|withdraw)\b/.test(
      evidence[0]
    )
  )
    return false;
  const parts = tail.slice(evidence[0].length).split(', ');
  if (parts.length !== 3) return false;
  const [work, proof, handoff] = parts;
  const completed = work.replace(/`[./_-]+`/g, 'path');
  if (
    /\b(?:run|start|commission|hold|fifth|new review|repeat|schedule|another round)\b/.test(
      completed + ' ' + proof
    )
  )
    return false;
  return (
    /^the [a-z0-9 '-]{1,150} (?:is|are) committed with (?:its|their) tests$/.test(completed) &&
    /^verified by [a-z -]{1,70} rather than another review$/.test(proof) &&
    new RegExp(
      '^and ' +
        mission.split('-')[1] +
        "'s (?:closing gates and close|closing checks) pass to the next agent$"
    ).test(handoff)
  );
}

/** Dates, provenance, pending state and candidate uniqueness are checked under the caller's locks. */
export function privateAnswerMatches(
  draft: string,
  decision: string,
  strictlyNewer: boolean
): boolean {
  if (!draft.trim() || !decision.trim()) return false;
  if (recordStatesDraft(draft, decision)) {
    // A copied question or report is still not an operative choice. Keep this optional route
    // narrow enough to recognize an affirmative instruction before relying on exact equality.
    const choice = decision.trim().replace(/\s+/g, ' ');
    return (
      KEEP_ARTIFACT.test(choice) &&
      draftCoverage(draft, decision) >= (strictlyNewer ? SETTLE_AFTER_FLOOR : ANSWER_COVERAGE)
    );
  }
  if (!strictlyNewer || decision.length > 1500 || /[\n\r?"“”]/.test(decision)) return false;
  const answer = decision.trim().toLowerCase().replace(/\.$/, '');
  const proposal = draft.trim().toLowerCase();
  if (
    /[?\n\r“”"]/.test(proposal) ||
    RETRACTION.test(proposal) ||
    /\b(?:hypothetically|example)\b/.test(proposal)
  )
    return false;
  // Reported, hypothetical, qualified and reversing speech cannot establish an answer.
  if (
    /\b(?:if|unless|but|however|actually|instead of|except when|temporarily|provisionally|probably|perhaps|may|might|should|would|could|correction|reverse|reinstate|resume|do not|not only|for now)\b/.test(
      answer
    )
  )
    return false;
  return (
    releaseRejected(proposal, answer) ||
    checkDropped(proposal, answer) ||
    roundRejected(proposal, answer)
  );
}

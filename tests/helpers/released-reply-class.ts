// SPDX-License-Identifier: Apache-2.0
// ABOUTME: 4.10.0's reply classifier, frozen over the published phrase lists, so the tests of s109-m03's rule R-c
// ABOUTME: check every message's class against the release before it: R-c may turn `question` into `other`, nothing else.

import {
  APPROVAL_PHRASES,
  DECLINE_PHRASES,
  PLAIN_REPLY_MAX,
  type ReplyClass,
} from '../../src/tools/rbook/draft-grammar';

const COURTESY = ['please', 'thanks', 'thank you', 'thx', 'ty'];

/** How 4.10.0 classified the operator's message: any "?" made it a question. */
export function releasedReplyClass(message: string): ReplyClass {
  const text = message
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const asks = text.includes('?');
  if (text === '' || text.length > PLAIN_REPLY_MAX || asks) return asks ? 'question' : 'other';
  const phrases = [
    ...APPROVAL_PHRASES.map((p) => ({ words: p.split(' '), type: 'approval' })),
    ...DECLINE_PHRASES.map((p) => ({ words: p.split(' '), type: 'decline' })),
    ...COURTESY.map((p) => ({ words: p.split(' '), type: 'courtesy' })),
  ].sort((a, b) => b.words.length - a.words.length);
  const types: string[] = [];
  for (const part of text
    .split(/[,.;!…]|\s[-–—]+\s|[–—]/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    const words = part.split(' ');
    let at = 0;
    while (at < words.length) {
      const phrase = phrases.find((p) => p.words.every((word, i) => words[at + i] === word));
      if (!phrase) return 'other';
      types.push(phrase.type);
      at += phrase.words.length;
    }
  }
  const approvals = types.includes('approval');
  const declines = types.includes('decline');
  if (approvals && !declines) return 'approval';
  if (declines && !approvals) return 'decline';
  return 'other';
}

/** R-c's contract for one message: whether its class is the release's, or `other` for a `question`. */
export function onlyQuestionToOther(released: ReplyClass, now: ReplyClass): boolean {
  return released === 'question' ? now === 'question' || now === 'other' : now === released;
}

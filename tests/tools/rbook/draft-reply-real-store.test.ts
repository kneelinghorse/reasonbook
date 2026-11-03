// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m03 (#52) — R-c over this project's own operator replies, read from the live store without writing:
// ABOUTME: #52's message with P83 and P84 reads other, and of the replies recorded through decision #1832 only it changes.

import { expect, it } from '@jest/globals';
import Database from 'better-sqlite3';

import { classifyReply } from '../../../src/tools/rbook/draft-grammar';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { onlyQuestionToOther, releasedReplyClass } from '../../helpers/released-reply-class';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "R-c's corpus is this project's own operator replies, kept as approval words on the live store's decisions.",
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

interface Reply {
  readonly message: string;
  readonly drafts: ReadonlyArray<{ id: number; text: string }>;
  /** The first decision that kept these words. */
  readonly first: number;
}

/**
 * The counting rule (E2's, decision #1059): each distinct approval_words of a decision, with every
 * draft a decision recorded from those words named. Read-only: the store is opened for reading.
 */
function replies(): Reply[] {
  const db = new Database(PRIVATE.paths.liveDb, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT d.id AS decision, d.approval_words AS message, p.id AS id, p.text AS text
           FROM strategic_decisions d JOIN proposals p ON 'P' || p.id = d.approval_draft
          WHERE d.approval_words IS NOT NULL ORDER BY d.id`
      )
      .all() as Array<{ decision: number; message: string; id: number; text: string }>;
    const byMessage = new Map<string, Reply>();
    for (const row of rows) {
      const seen = byMessage.get(row.message);
      const draft = { id: row.id, text: row.text };
      byMessage.set(
        row.message,
        seen
          ? { ...seen, drafts: [...seen.drafts, draft] }
          : { message: row.message, drafts: [draft], first: row.decision }
      );
    }
    return [...byMessage.values()];
  } finally {
    db.close();
  }
}

PRIVATE.describe("R-c over this store's operator replies", () => {
  it('#52: the words decisions #1809 and #1810 kept read other with P83 and P84', () => {
    const fiftyTwo = replies().find((reply) => reply.first === 1809);
    expect(fiftyTwo?.drafts.map((draft) => draft.id)).toEqual([83, 84]);
    expect(releasedReplyClass(fiftyTwo!.message)).toBe('question');
    expect(classifyReply(fiftyTwo!.message, fiftyTwo!.drafts)).toBe('other');
  });

  it('of the replies recorded through decision #1832, only #52’s changes', () => {
    const through = replies().filter((reply) => reply.first <= 1832);
    // E2 counted 31 on 2026-11-01; decisions recorded since add to them.
    expect(through.length).toBeGreaterThanOrEqual(31);
    const changed = through.filter(
      (reply) => classifyReply(reply.message, reply.drafts) !== releasedReplyClass(reply.message)
    );
    expect(changed.map((reply) => reply.first)).toEqual([1809]);
  });

  it('every reply, whenever recorded, changes only from question to other', () => {
    for (const reply of replies()) {
      const before = releasedReplyClass(reply.message);
      const after = classifyReply(reply.message, reply.drafts);
      expect([reply.first, before, after, onlyQuestionToOther(before, after)]).toEqual([
        reply.first,
        before,
        after,
        true,
      ]);
    }
  });
});

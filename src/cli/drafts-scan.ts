// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Scans draft-session transcripts within the hook budget and retains outside-content evidence.
// ABOUTME: Unread or changed transcript regions remain unknown rather than asserting clean provenance.
import * as fs from 'fs';
import {
  readScans,
  saveScan,
  type DraftRuntime,
  type ScanState,
} from '../tools/rbook/draft-runtime';
import { scanFile, SCAN_MAX_BYTES, sessionTranscripts, transcriptKey } from './transcript-scan';

/** The session's outside-content flag over every file scanned: 1 seen, 0 none, null unknown. */
export function sessionOutside(state: ScanState): number | null {
  const values = [...state.files.values()].map((file) => file.outside);
  if (values.includes(1)) return 1;
  if (!values.length || values.includes(null)) return null;
  return 0;
}

const MISSING_SUBAGENTS = 'subagents-missing';

/** Scan what the session's transcripts gained, inside the time left; returns the session's flag. */
export function scanSession(
  runtime: DraftRuntime,
  session: string,
  main: string,
  deadlineAtMs: number
): number | null {
  const prior = readScans(runtime, session);
  let budget = SCAN_MAX_BYTES;
  const files = sessionTranscripts(main);
  for (const file of files) {
    const key = transcriptKey(file);
    const before = prior.files.get(key);
    if (Date.now() >= deadlineAtMs || budget <= 0) {
      // Not read this time: a file that grew past its last scan is unknown, never "none" (the
      // build critic, N2). A file already flagged stays flagged.
      let grew = true;
      try {
        grew = fs.statSync(file).size > (before?.scanned ?? 0);
      } catch {
        // Unreadable: unknown.
      }
      if (!before || (grew && before.outside !== 1))
        saveScan(runtime, session, key, {
          scanned: before?.scanned ?? 0,
          outside: before?.outside === 1 ? 1 : null,
        });
      continue;
    }
    try {
      const result = scanFile(file, before?.scanned ?? 0, budget, deadlineAtMs);
      budget -= result.bytes;
      const outside =
        result.outside || before?.outside === 1
          ? 1
          : !result.complete || (before !== undefined && before.outside === null)
            ? null
            : 0;
      saveScan(runtime, session, key, { scanned: result.scanned, outside });
      if (file === main && result.subagent && files.length === 1)
        saveScan(runtime, session, MISSING_SUBAGENTS, { scanned: 0, outside: null });
    } catch {
      saveScan(runtime, session, key, {
        scanned: before?.scanned ?? 0,
        outside: before?.outside === 1 ? 1 : null,
      });
    }
  }
  return sessionOutside(readScans(runtime, session));
}

// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m12 — this repository's own rules file stays readable by every agent: agents.md fits under
// ABOUTME: Codex's 32 KiB read limit with a margin, CLAUDE.md imports it, and the moved reference is linked.

/**
 * WHY (decision #1183; design doc rbook/planning/s93-the-loop-runs-itself-build.md, m12 fork 6).
 * agents.md was 98,095 bytes, two-thirds of it architecture reference, and Codex reads the first
 * 32 KiB of a rules file. The reference moved to rbook/docs/architecture.md, linked from agents.md,
 * and CLAUDE.md imports agents.md so Claude Code loads every rule rather than a pointer to them.
 *
 * Private evidence: agents.md, CLAUDE.md and rbook/ are not mirrored, so the public repository skips
 * this block by scope (tests/helpers/public-mirror.ts), and says so.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';

import { requiresPrivateEvidence } from '../helpers/public-mirror';

/** s110-m05 leaves at least 1 KiB below the former 30 KiB gate for later rule changes. */
const AGENTS_MD_LIMIT_BYTES = 29 * 1024;

const PRIVATE = requiresPrivateEvidence({
  reason: "this repository's private rules files",
  paths: {
    agents: 'agents.md',
    claude: 'CLAUDE.md',
    architecture: 'rbook/docs/architecture.md',
  },
});

describe('s93-m12 — one readable rules file for this repository', () => {
  PRIVATE.describe('agents.md, CLAUDE.md and the architecture reference', () => {
    it(`agents.md is at most ${AGENTS_MD_LIMIT_BYTES} bytes`, () => {
      expect(fs.statSync(PRIVATE.paths.agents).size).toBeLessThanOrEqual(AGENTS_MD_LIMIT_BYTES);
    });

    it('CLAUDE.md imports agents.md', () => {
      const lines = fs.readFileSync(PRIVATE.paths.claude, 'utf8').split('\n');
      expect(lines).toContain('@agents.md');
    });

    it('agents.md links the moved reference, and the reference links back', () => {
      expect(fs.readFileSync(PRIVATE.paths.agents, 'utf8')).toContain(
        '(rbook/docs/architecture.md)'
      );
      expect(fs.readFileSync(PRIVATE.paths.architecture, 'utf8')).toContain('(../../agents.md)');
    });
  });
});

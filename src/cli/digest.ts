// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The CLI and session-start hook read the same bounded local digest as MCP review.
// ABOUTME: Fleet feedback counts are bounded; no migrations or dashboard work runs and typed spans measure delivery.

import type { ResolvedBy } from '../intelligence/sender-context';
import { readDigestV2 } from '../tools/rbook/digest-v2-store';
import { renderDigestV2 } from '../tools/rbook/digest-v2';
import { CliStoreError, type CliIo } from './core';
import { observeRenderedContext } from './telemetry';

export async function buildDigest(
  projectRoot: string,
  io?: CliIo,
  deadlineAtMs = Infinity,
  resolvedBy: ResolvedBy = 'explicit',
  sessionStart = false
): Promise<string> {
  try {
    const context = renderDigestV2(
      await readDigestV2(projectRoot, io?.env, deadlineAtMs - 20, undefined, { sessionStart }),
      {
        projectRoot,
        resolvedBy,
      }
    );
    observeRenderedContext(io, context);
    return context.text;
  } catch (error) {
    throw new CliStoreError(
      error instanceof Error ? error.message : 'The digest could not be read.'
    );
  }
}

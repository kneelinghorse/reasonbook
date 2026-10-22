// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Describe the installed copy's library and supported record reads without changing its write protocol.
// ABOUTME: Treat absent or malformed peer claims as unreported and replace stale claims on downgrade.
import { getServerVersion } from '../../server-version';
import { PROTOCOL_VERSION } from './record-protocol';

export interface CopyReport {
  readonly libraryVersion?: string | null;
  readonly reads?: number | null;
}
export interface ReportedCopy {
  readonly libraryVersion: string | null;
  readonly reads: number | null;
}

/** The supported reader capacity, including the explicit older/future-release test seam. */
export function localCopyReport(): { readonly libraryVersion: string; readonly reads: number } {
  return { libraryVersion: getServerVersion(), reads: PROTOCOL_VERSION };
}

/** No missing, malformed or null field can authorize a feature gate. */
export function copyReport(value: unknown): ReportedCopy {
  const input = value && typeof value === 'object' ? (value as CopyReport) : {};
  return {
    libraryVersion:
      typeof input.libraryVersion === 'string' &&
      input.libraryVersion.length <= 128 &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(input.libraryVersion)
        ? input.libraryVersion
        : null,
    reads:
      typeof input.reads === 'number' && Number.isSafeInteger(input.reads) && input.reads > 0
        ? input.reads
        : null,
  };
}

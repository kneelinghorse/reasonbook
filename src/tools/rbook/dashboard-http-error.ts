// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps HTTP status, dashboard error envelopes and Retry-After on failed requests.
// ABOUTME: Upload classification uses this evidence without treating intermediary errors as refusals.

import { RbookErrors } from './errors';
import type { RbookToolError } from './types';

export async function dashboardHttpError(
  response: Response,
  baseUrl: string,
  resource: string,
  failurePrefix?: string,
  uploadRecovery = false
): Promise<RbookToolError> {
  const text = await response.text().catch(() => 'Unknown error');
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    // A proxy's non-JSON refusal is transient evidence, not a dashboard authorization answer.
  }
  const detail = typeof body?.error === 'string' ? body.error : undefined;
  const hint = typeof body?.hint === 'string' ? body.hint : undefined;
  const dashboardEnvelope = Boolean(detail);
  const header = response.headers.get('Retry-After');
  const seconds = header !== null && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN;
  const retryAt = header === null ? NaN : Date.parse(header);
  const retryAfterMs = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(retryAt)
      ? Math.max(0, retryAt - Date.now())
      : undefined;
  let error: RbookToolError;
  if (response.status === 401) error = RbookErrors.dashboardAuthFailed(baseUrl);
  else if (response.status === 403 && (dashboardEnvelope || !uploadRecovery))
    error = RbookErrors.dashboardForbidden(resource, detail, hint);
  else if (response.status === 402) error = RbookErrors.dashboardUpgradeRequired(text || undefined);
  else if (response.status === 404) error = RbookErrors.dashboardNotFound(resource, detail, hint);
  else if (uploadRecovery && response.status === 410 && body?.code === 'PROJECT_DELETED')
    error = {
      code: 'PROJECT_DELETED',
      message: detail ?? 'This project was deleted on reasonbook.ai.',
      suggestion:
        'Uploads for this project are stopped. Creating it again is not available in this version; a new registration needs your consent.',
    };
  else
    error = RbookErrors.dashboardError(
      failurePrefix
        ? `${failurePrefix}: HTTP ${response.status}: ${text}`
        : response.status >= 500
          ? `Server error ${response.status}: ${text}`
          : detail
            ? hint
              ? `${detail} (${hint})`
              : detail
            : `HTTP ${response.status}: ${text}`
    );
  return {
    ...error,
    currentState: {
      httpStatus: response.status,
      dashboardEnvelope,
      ...(typeof body?.code === 'string' ? { dashboardCode: body.code } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    },
  };
}

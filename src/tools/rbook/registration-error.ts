// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Explains create-only registration refusals without adopting an existing record's identity.
// ABOUTME: Keeps the same actionable collision remedy in direct errors and later upload notices.

import { dashboardHttpError } from './dashboard-http-error';
import { REGISTRATION_CONFLICT_PREFIX } from '../../intelligence/project-upload-reader';
import type { RbookToolError } from './types';

export async function registrationError(
  response: Response,
  baseUrl: string,
  resource: string,
  projectName: string
): Promise<RbookToolError> {
  if (response.status === 409) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as {
      error?: { code?: string; existingProject?: Record<string, unknown> };
    } | null;
    const existing = body?.error?.existingProject;
    if (body?.error?.code === 'PROJECT_NAME_CONFLICT' && existing) {
      const name = typeof existing.projectName === 'string' ? existing.projectName : projectName;
      return {
        code: 'PROJECT_NAME_CONFLICT',
        message: `${REGISTRATION_CONFLICT_PREFIX}your account already owns ${JSON.stringify(name)}${existing.archived === true ? ' (archived)' : ''}. This store has not joined or replaced it.`,
        suggestion:
          'Rename this store with rbook_project(action="init", projectRoot="<project folder>", projectName="<different name>"), then close again. ' +
          `If the old copy is gone (for example, a re-clone), delete the old project on ${baseUrl}, then close again; any other old copies stop uploading. ` +
          'If the record is shared and a copy that holds it is reachable, remove only this fresh store. ' +
          'For a record shared through the dashboard, join with rbook_project(action="join", via="dashboard", projectRoot="<empty project folder>", project="<shared rbook:// address>"). ' +
          'For SSH/bundle sharing, first run reasonbook copy --to "<staging folder>" --project-root "<owner project folder>" on the reachable owner and transfer that copy to this machine. Then invite this member from the owner copy and join there with rbook_project(action="join", projectRoot="<owner project folder>", member="<invited member>", host="<this SSH host>", remoteRoot="<copied project folder>").',
        currentState: {
          httpStatus: 409,
          dashboardEnvelope: true,
          dashboardCode: 'PROJECT_NAME_CONFLICT',
          existingProject: existing,
        },
      };
    }
  }
  if (response.status === 404) {
    return {
      code: 'DASHBOARD_REGISTRATION_UNAVAILABLE',
      message: 'This dashboard does not provide safe create-only registration.',
      suggestion:
        'Update the dashboard to a version with create-only registration, then close again. This client will not fall back to registration that can replace an existing project.',
      currentState: { httpStatus: 404 },
    };
  }
  return dashboardHttpError(response, baseUrl, resource, 'Registration failed', true);
}

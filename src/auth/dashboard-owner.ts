// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Gate project-key changes on the current owner of a shared record before touching credentials.
// ABOUTME: Reuses the upload authority check; unreadable stores refuse visibly rather than reaching the dashboard.
import * as fs from 'fs';
import { resolveRecordPaths } from '../intelligence/legacy-compat';
import { isMembersStore, readUploadProject } from '../tools/rbook/dashboard-upload';
import type { RbookToolError } from '../tools/rbook/types';

export async function dashboardOwnerError(projectRoot: string): Promise<RbookToolError | null> {
  try {
    // Missing stores still use each caller's existing registration/credential error.
    if (!fs.existsSync(resolveRecordPaths(projectRoot).dbPath)) return null;
    const project = readUploadProject(projectRoot);
    if (project && (await isMembersStore(project))) {
      return {
        code: 'DASHBOARD_OWNER_REQUIRED',
        message:
          "This is a member's copy; the dashboard mirror and its project keys belong to the owner's copy.",
        suggestion: "Rotate or recover the dashboard project key from the owner's copy.",
      };
    }
    return null;
  } catch (error) {
    return {
      code: 'DASHBOARD_OWNER_UNREADABLE',
      message: `Could not check this copy's dashboard ownership: ${error instanceof Error ? error.message : String(error)}`,
      suggestion:
        "Repair the local store before changing its dashboard keys, or use the owner's healthy copy.",
    };
  }
}

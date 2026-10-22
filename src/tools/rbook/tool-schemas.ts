// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Supplies every published MCP tool's whole schema to the dispatcher.
// ABOUTME: Kept outside the pure validator so CLI actions load only the schema they use.

import type { z } from 'zod';
import { rbookMissionSchema } from './rbook-mission';
import { rbookMissionTransitionSchema } from './rbook-mission-transition';
import { rbookSprintSchema } from './rbook-sprint';
import { rbookContextSchema } from './rbook-context';
import { rbookSessionSchema } from './rbook-session';
import { rbookDecisionsSchema } from './rbook-decisions';
import { rbookDbSchema } from './rbook-db';
import { rbookProjectSchema } from './rbook-project';
import { rbookLearningsSchema } from './rbook-learnings';
import { rbookFeedbackSchema } from './rbook-feedback';
import { rbookAuthSchema } from './rbook-auth';
import { rbookMessageSchema } from './rbook-message';
import { rbookAgentOnboardSchema } from './rbook-agent-onboard';
import { rbookStatusSchema } from './rbook-status';
import { rbookReviewSchema } from './rbook-review';

/** Inventory equality with tools/list is asserted by the dispatch tests. */
export const RBOOK_TOOL_SCHEMAS: Readonly<Record<string, z.ZodObject>> = {
  rbook_mission: rbookMissionSchema,
  rbook_mission_transition: rbookMissionTransitionSchema,
  rbook_sprint: rbookSprintSchema,
  rbook_context: rbookContextSchema,
  rbook_session: rbookSessionSchema,
  rbook_decisions: rbookDecisionsSchema,
  rbook_db: rbookDbSchema,
  rbook_project: rbookProjectSchema,
  rbook_learnings: rbookLearningsSchema,
  rbook_feedback: rbookFeedbackSchema,
  rbook_auth: rbookAuthSchema,
  rbook_message: rbookMessageSchema,
  rbook_agent_onboard: rbookAgentOnboardSchema,
  rbook_status: rbookStatusSchema,
  rbook_review: rbookReviewSchema,
};

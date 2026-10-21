// SPDX-License-Identifier: Apache-2.0
// ABOUTME: @aquex/reasonbook/signals: what needs a person in a Reasonbook store, read-only, the same rules on this client
// ABOUTME: and at the dashboard's ingest. No sqlite-vec, embedder, hooks, timers, network or project discovery.

export {
  computeSignals,
  readSignals,
  SIGNAL_RULES,
  SIGNAL_RULES_AGE_ONLY,
  unreadableReport,
  type ComputeSignalsOptions,
} from './read-signals';
export {
  SIGNAL_KINDS,
  SIGNAL_MAX_IDS,
  SIGNALS_DEFAULT_WINDOW_DAYS,
  SIGNALS_LIBRARY_NAME,
  SIGNALS_SCHEMA,
  type FeedbackKindsReport,
  type ReadSignalsOptions,
  type SignalEntry,
  type SignalKind,
  type SignalsReport,
  type WindowCounts,
} from './report';
export {
  classifyFeedback,
  countFeedbackKinds,
  FEEDBACK_KIND_RULES,
  FEEDBACK_KINDS,
  FEEDBACK_KINDS_RULE,
  FOLDED_FEEDBACK_KINDS,
  type FeedbackClassification,
  type FeedbackKind,
  type FeedbackKindCounts,
  type FeedbackKindInfo,
  type FeedbackKindRule,
  type FoldedFeedbackKind,
} from './feedback-kinds';
export { ACTIVITY_TABLES, CONSTRAINTS_EXPIRING_DAYS, QUIET_SILENT_DAYS } from './rules-activity';
export {
  BRIEF_LINE_IDS,
  BRIEF_MAX_LINES,
  BRIEF_SECTION_ITEMS,
  buildBrief,
  renderBrief,
  type Brief,
  type BriefItem,
  type BriefOptions,
  type BriefSection,
  type BriefSectionId,
} from './brief';
export { SIGNALS_REVIEW_THRESHOLD } from './rules-records';

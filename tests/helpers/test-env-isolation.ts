// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Separates explicit Jest run controls from inherited product settings and credentials.
// ABOUTME: Restores only the current setting spelling so deleting it cannot reveal a stale fallback.
import { getSetting, settingNames } from '../../src/intelligence/legacy-compat';

export const RUN_ENV_KEY = 'JEST_RECORD_RUN_ENV';
export const CURRENT_SETTING_PREFIX = 'RBOOK_';
const CONTROL_SUFFIXES = [
  'CHECKPOINT_SYNC',
  'LIVE_DASHBOARD',
  'LIVE_PROJECT_ID',
  'UPLOAD_FIXTURE',
  'ANSWER_SHAPE_EMIT_ROOT',
  'ANSWER_SHAPE_CHANGELOG',
  'ANSWER_SHAPE_SOURCE_ROOT',
  'CODEX_REAL_STORE_ROOT',
  'ADDRESS_REAL_STORE_ROOT',
  // s107-m04: the build-freshness fire test's source store.
  'FRESHNESS_REAL_STORE_ROOT',
  // s96-m12: how many random orders the interleaving property tries (its default is 100).
  'INTERLEAVINGS',
  'INTERLEAVINGS_DEBUG',
] as const;
const CREDENTIAL_SUFFIXES = ['DASHBOARD_API_KEY', 'DASHBOARD_USER', 'DASHBOARD_PASSWORD'] as const;
const LIVE_SUFFIXES = ['DASHBOARD_URL', ...CREDENTIAL_SUFFIXES] as const;
export type RunControls = Partial<Record<string, string>>;

export function captureRunControls(env: NodeJS.ProcessEnv): RunControls {
  const controls: RunControls = {};
  const suffixes = [
    ...CONTROL_SUFFIXES,
    ...(getSetting('LIVE_DASHBOARD', env) === '1' ? LIVE_SUFFIXES : []),
  ];
  for (const suffix of suffixes) {
    const value = getSetting(suffix, env);
    if (value !== undefined) controls[suffix] = value;
  }
  controls.CHECKPOINT_SYNC ??= 'off';
  return controls;
}

export function clearProductSettings(env: NodeJS.ProcessEnv): void {
  const prefixes = settingNames('');
  for (const name of Object.keys(env)) {
    if (prefixes.some((prefix) => name.startsWith(prefix))) delete env[name];
  }
}

export function restoreRunControls(
  env: NodeJS.ProcessEnv,
  controls: RunControls,
  configDir?: string
): void {
  const suffixes = [...CONTROL_SUFFIXES, ...(controls.LIVE_DASHBOARD === '1' ? LIVE_SUFFIXES : [])];
  for (const suffix of suffixes) {
    for (const name of settingNames(suffix)) delete env[name];
    if (controls[suffix] !== undefined)
      env[`${CURRENT_SETTING_PREFIX}${suffix}`] = controls[suffix];
  }
  if (configDir) {
    for (const name of settingNames('CONFIG_DIR')) delete env[name];
    env[`${CURRENT_SETTING_PREFIX}CONFIG_DIR`] = configDir;
  }
}

/** Runs before file hooks: keep current beforeAll fixtures, remove old fallback and real credentials. */
export function cleanBeforeTest(env: NodeJS.ProcessEnv, controls: RunControls): void {
  const otherPrefixes = settingNames('').filter((prefix) => prefix !== CURRENT_SETTING_PREFIX);
  for (const name of Object.keys(env)) {
    if (otherPrefixes.some((prefix) => name.startsWith(prefix))) delete env[name];
  }
  // A repository .env import must never opt the network guard into a live run.
  for (const name of settingNames('LIVE_DASHBOARD')) delete env[name];
  if (controls.LIVE_DASHBOARD !== undefined)
    env[`${CURRENT_SETTING_PREFIX}LIVE_DASHBOARD`] = controls.LIVE_DASHBOARD;
  if (controls.LIVE_DASHBOARD !== '1') {
    for (const suffix of CREDENTIAL_SUFFIXES) {
      for (const name of settingNames(suffix)) delete env[name];
    }
  }
}

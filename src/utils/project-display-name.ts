// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Choose a readable project label without storing a default name or changing its identity.
// ABOUTME: Current and legacy record paths resolve to the project folder; standalone stores use their parent.

import * as path from 'path';
import { isRecordDirectoryName } from '../intelligence/legacy-compat';

export function projectDisplayName(projectRoot: string, ...names: readonly unknown[]): string {
  for (const name of names) {
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return path.basename(path.resolve(projectRoot));
}

export function projectRootFromStore(storePath: string): string {
  const directory = path.dirname(path.resolve(storePath));
  const record = path.dirname(directory);
  return path.basename(directory) === 'db' && isRecordDirectoryName(path.basename(record))
    ? path.dirname(record)
    : directory;
}

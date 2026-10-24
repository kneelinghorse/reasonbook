// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Tell an older recipient what to do when its sender withholds unreadable changes.
// ABOUTME: Share action-first wording across SSH, local exchanges, referees and bundle warnings.
import { UPGRADE_COMMAND } from './record-protocol-hold';
import type { ChangeSelection } from './record-since';

export function protocolDeliveryNotice(
  selected: Pick<ChangeSelection, 'withheld' | 'withheldProtocol'>
): { readonly message: string; readonly suggestion: string } {
  return {
    message: `Upgrade Reasonbook here (${UPGRADE_COMMAND}): this record writes record protocol ${selected.withheldProtocol}, so ${selected.withheld} change(s) were withheld from this older reader. Sync again after upgrading.`,
    suggestion: `Run ${UPGRADE_COMMAND} on this machine, then run reasonbook sync; the sending copy keeps the withheld changes.`,
  };
}

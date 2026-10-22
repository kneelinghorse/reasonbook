// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A move receipt requires the receiver's actual applied, pending or held-fork evidence.
// ABOUTME: An unrelated move or absence of unreadable incoming rows cannot prove the advertised move arrived.
import type { Hello } from './record-exchange-types';

export function receivedMove(
  after: Pick<Hello, 'epoch' | 'authority' | 'pending' | 'forks'>,
  advertised: Pick<Hello, 'epoch' | 'authority'>
): { readonly epoch: number; readonly authority: string } | null {
  const matches = (held: Pick<Hello, 'epoch' | 'authority'>) =>
    held.epoch === advertised.epoch && held.authority === advertised.authority;
  const held = [after, ...(after.pending ? [after.pending] : []), ...(after.forks ?? [])].find(
    matches
  );
  return held ? { epoch: held.epoch, authority: held.authority } : null;
}

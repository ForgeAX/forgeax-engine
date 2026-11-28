import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import type { JoinedChain } from './query/stitch';
import { brepFail } from './types';

/**
 * Fail-closed entry for an intersection chain that a NURBS face split would consume. Only an open
 * chain whose ends all stop at a face boundary is a split line; closed chains and gap or junction
 * ends are refused with the first offending reason.
 */
export function refuseOpenChain(chain: JoinedChain): Result<null, ModelingError> {
  if (chain.closed) {
    return brepFail<null>('brep-ssi-unsupported', 'an open chain of boundary-ended branches', {
      reason: 'closed-chain',
    });
  }
  const bad = chain.ends.find((e) => e.reason !== 'boundary');
  if (bad !== undefined) {
    return brepFail<null>('brep-ssi-unsupported', 'an open chain of boundary-ended branches', {
      reason: bad.reason,
    });
  }
  return ok(null);
}

/**
 * Fail-closed entry for the chains of one NURBS face against an analytic cylinder. A transverse
 * cylinder cuts a closed hole loop; every other chain (open, gap-over-tol, junction) or a measured
 * partial is refused with its first reason. Accepted loops are returned as chain indices.
 */
export function closedHoleLoops(
  chains: readonly JoinedChain[],
  partial: string | undefined,
): Result<readonly number[], ModelingError> {
  const fail = (reason: string) =>
    brepFail<readonly number[]>(
      'brep-ssi-unsupported',
      'closed hole loops of a NURBS x cylinder section',
      {
        reason,
      },
    );
  if (partial !== undefined) return fail(`partial:${partial}`);
  const loops: number[] = [];
  for (let i = 0; i < chains.length; i++) {
    const c = chains[i] as JoinedChain;
    if (c.closed) {
      loops.push(i);
      continue;
    }
    const bad = c.ends.find((e) => e.reason !== 'boundary');
    return fail(bad === undefined ? 'open-chain' : bad.reason);
  }
  return ok(loops);
}

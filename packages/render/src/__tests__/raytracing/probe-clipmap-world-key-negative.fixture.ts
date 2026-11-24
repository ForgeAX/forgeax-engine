import { type WorldPoint, worldKeyPlan } from './probe-clipmap-world-key.fixture';

export const negativeKeyFocus: WorldPoint = [0.75, 0.5, 0.5];
export const negativeKeyNextFocus: WorldPoint = [0.25, 0.5, 0.5];
export const negativeKeyPlan = () => worldKeyPlan([-0.5, -32.5, -32.5]);

/** Single deliberately wrong signed-remainder conversion, not an admission heuristic. */
export function rawRemainderQueryOwner(owner: string): string {
  const correct = 'let c = vec3u(((cell % d) + d) % d);';
  const index = owner.indexOf(correct);
  if (index < 0 || owner.lastIndexOf(correct) !== index)
    throw new Error('Signed remainder control requires one exact producer expression');
  return `${owner.slice(0, index)}let c = vec3u(cell % d);${owner.slice(index + correct.length)}`;
}

/** Independent integer constants establish that this particular mutant is nondegenerate. */
export function negativeRemainderWitness() {
  const cell = -4,
    dimension = 6;
  const candidates = Array.from({ length: dimension }, (_, i) => i).filter((value) =>
    Number.isInteger((cell - value) / dimension),
  );
  if (candidates.length !== 1 || candidates[0] === undefined)
    throw new Error('Negative residue oracle ambiguous');
  const expected = candidates[0],
    raw = (cell % dimension) >>> 0;
  // y,z residues1 select a finite in-range wrong row after u32 address arithmetic.
  return {
    cell,
    dimension,
    expected,
    raw,
    expectedSlot: ((1 * 4 + 1) * 6 + expected) >>> 0,
    wrongSlot: ((1 * 4 + 1) * 6 + raw) >>> 0,
  };
}

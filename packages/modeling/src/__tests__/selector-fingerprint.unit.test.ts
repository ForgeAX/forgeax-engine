import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { recordSelectors, type SelectorLog, sel } from '../selectors';

/** One quad face tilted `deg` degrees about the z axis from the flat +y plane. */
function tiltedQuad(deg: number) {
  const t = (deg * Math.PI) / 180;
  const ux = Math.cos(t);
  const uy = -Math.sin(t);
  const at = (s: number, r: number): [number, number, number] => [s * ux, s * uy, r];
  const m = model();
  m.polygon({ points: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)], tag: 'tilt', label: 'tilt' });
  return m;
}

/** The fingerprint the regen audit compares for the face tagged `tilt`. */
function signatureAt(deg: number): string {
  const m = tiltedQuad(deg);
  const log: SelectorLog = { uses: [], truncated: false };
  recordSelectors(log, () => sel.tag('tilt').resolve(m.editMesh));
  const use = log.uses[0];
  if (use === undefined) throw new Error('no selector use recorded');
  return use.signature;
}

describe('selector fingerprint', () => {
  it('control: a 45 degree tilt changes the fingerprint, so the pins below test the band', () => {
    expect(signatureAt(45)).not.toBe(signatureAt(0));
  });

  it.fails('FR-C12: a 10 degree tilt of the selected face changes its fingerprint', () => {
    expect(signatureAt(10)).not.toBe(signatureAt(0));
  });

  it.fails('FR-C12: a 1 degree change across the 0.4 band edge does not change the fingerprint', () => {
    // sin(23 deg) < 0.4 <= sin(24 deg): the same geometry class flips on a 1 degree jitter.
    expect(signatureAt(23)).toBe(signatureAt(24));
  });
});

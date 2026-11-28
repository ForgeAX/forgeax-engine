import { triangleContact } from '../intersect';
import type { PairCase } from './triangle-contact-corpus';
import { referenceTriangleContact } from './triangle-contact-reference';

type Contact = ReturnType<typeof referenceTriangleContact>;

/** Compares `triangleContact` with the oracle over a pair corpus; `bad` keeps the first mismatches. */
export function compareTriangleContact(pairs: readonly PairCase[]): {
  classes: Set<Contact>;
  bad: string[];
} {
  const classes = new Set<Contact>();
  const bad: string[] = [];
  for (const p of pairs) {
    const expected = referenceTriangleContact(p.t1, p.t2, p.tolerance);
    const actual = triangleContact(p.t1, p.t2, p.tolerance);
    classes.add(expected);
    if (actual !== expected && bad.length < 10) {
      bad.push(
        `${p.kind} tol=${p.tolerance} expected=${expected} actual=${actual} ${JSON.stringify([p.t1, p.t2])}`,
      );
    }
  }
  return { classes, bad };
}

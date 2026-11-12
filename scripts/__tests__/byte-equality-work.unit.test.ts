import { expect, it } from 'vitest';
import { observeByteEqualityWork } from '../../config/byte-equality-work';
import { equalByteMaps, equalBytes } from '../test/byte-equality.mjs';

it('observes the pinned real matcher and rejects restored generic byte work', () => {
  const work = observeByteEqualityWork();
  try {
    expect(new Uint8Array(16 * 1024)).toEqual(new Uint8Array(16 * 1024));
    expect(work.counts).toEqual({ genericComparisons: 1, genericBytes: 32 * 1024 });
    expect(() => work.assertNoGenericComparisons()).toThrow('Dawn byte-oracle work regressed');
  } finally {
    work.stop();
  }
});

it('retains equality and inequality outcomes while observing generic work', () => {
  const work = observeByteEqualityWork();
  try {
    expect(new Uint8Array(16 * 1024)).not.toEqual(new Uint8Array(16 * 1024).fill(1));
    expect(new Uint8Array(16 * 1024)).not.toEqual(new Uint8Array(16 * 1024 + 1));
    expect(work.counts.genericComparisons).toBe(2);
  } finally {
    work.stop();
  }
});

it('keeps full payload oracles outside the generic-object traversal', () => {
  const work = observeByteEqualityWork();
  try {
    const bytes = new Uint8Array(16 * 1024).fill(23);
    expect(equalBytes(bytes, bytes.slice())).toBe(true);
    expect(equalByteMaps(new Map([['all', bytes]]), new Map([['all', bytes.slice()]]))).toBe(true);
    expect(bytes).toEqual(bytes);
    expect(new Uint8Array([1, 2])).toEqual(new Uint8Array([1, 2]));
    expect(work.counts.genericComparisons).toBe(0);
    work.assertNoGenericComparisons();
    work.stop();
    expect(bytes).toEqual(bytes.slice());
    expect(work.counts.genericComparisons).toBe(0);
  } finally {
    work.stop();
  }
});

it('observes a later file lifetime after the preceding observer stops', () => {
  const first = observeByteEqualityWork();
  first.stop();
  const second = observeByteEqualityWork();
  try {
    expect(new Uint8Array(16 * 1024)).toEqual(new Uint8Array(16 * 1024));
    expect(first.counts.genericComparisons).toBe(0);
    expect(second.counts.genericComparisons).toBe(1);
  } finally {
    second.stop();
  }
});

it('exposes deep matcher work hidden inside a successful reference-inequality oracle', () => {
  const work = observeByteEqualityWork();
  try {
    const first = new Uint8Array(16 * 1024).fill(21);
    const second = first.slice();
    expect(first).not.toBe(second);
    expect(work.counts.genericComparisons).toBe(1);
    work.stop();
    const explicit = observeByteEqualityWork();
    try {
      expect(Object.is(first, second)).toBe(false);
      expect(explicit.counts.genericComparisons).toBe(0);
      explicit.assertNoGenericComparisons();
    } finally {
      explicit.stop();
    }
  } finally {
    work.stop();
  }
});

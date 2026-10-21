import { describe, expect, it, vi } from 'vitest';
import { MeshChanges, ShadowMeshReads } from '../device/mesh-changes';

describe('native Mesh publication changes', () => {
  it('does not let a newer content edit conceal an older related retirement', () => {
    const changes = new MeshChanges();
    const retired = changes.create(),
      live = changes.create();
    const reads = new ShadowMeshReads(changes);
    reads.add(retired);
    reads.add(live);
    const accepted = changes.epoch;
    try {
      changes.retire(retired);
      changes.publish(live);
      expect(changes.query(accepted, reads.generation, reads.tokens)).toBe('invalidated');
      expect(retired.owner).toBe(changes);
    } finally {
      reads.release();
      expect(retired.owner).toBeUndefined();
      changes.reset();
    }
  });

  it('keeps content evidence independent of each accepted cursor and aborted borrower', () => {
    const changes = new MeshChanges();
    const live = changes.create();
    const reads = new ShadowMeshReads(changes);
    reads.add(live);
    const oldCursor = changes.epoch;
    try {
      changes.publish(live);
      const borrower = reads.retain();
      expect(changes.query(oldCursor, borrower.generation, borrower.tokens)).toBe('content');
      borrower.release(); // Aborting does not mutate any consumer's accepted cursor.
      expect(changes.query(changes.epoch, reads.generation, reads.tokens)).toBe('quiet');
      expect(changes.query(oldCursor, reads.generation, reads.tokens)).toBe('content');
      expect(live.holders).toBe(2);
    } finally {
      reads.release();
      expect(live.holders).toBe(1);
      changes.reset();
    }
  });

  it('queries only distinct latest changes, without walking dependencies', () => {
    const changes = new MeshChanges();
    const watched = changes.create();
    const reads = new ShadowMeshReads(changes);
    reads.add(watched);
    const unrelated = Array.from({ length: 10000 }, () => changes.create());
    const accepted = changes.epoch;
    const has = vi.spyOn(reads.tokens, 'has');
    for (const name of ['values', 'entries', 'keys', 'forEach'] as const)
      vi.spyOn(reads.tokens, name).mockImplementation(() => {
        throw new Error('dependency scan');
      });
    vi.spyOn(reads.tokens, Symbol.iterator).mockImplementation(() => {
      throw new Error('dependency scan');
    });
    try {
      expect(changes.query(accepted, reads.generation, reads.tokens)).toBe('quiet');
      expect(has).not.toHaveBeenCalled();
      for (const token of unrelated.slice(0, 3)) changes.publish(token);
      expect(changes.query(accepted, reads.generation, reads.tokens)).toBe('quiet');
      expect(has).toHaveBeenCalledTimes(3);
      has.mockClear();
      const last = unrelated[0];
      if (last === undefined) throw new Error('missing admitted Mesh');
      for (let edit = 0; edit < 1000; edit++) changes.publish(last);
      expect(changes.query(accepted, reads.generation, reads.tokens)).toBe('quiet');
      expect(has).toHaveBeenCalledTimes(3); // repeated edits never append history
      changes.publish(watched);
      expect(changes.query(accepted, reads.generation, reads.tokens)).toBe('content');
    } finally {
      vi.restoreAllMocks();
      reads.release();
      changes.reset();
    }
  });

  it('retains retirement evidence until the final prepared/accepted borrower retires', () => {
    const changes = new MeshChanges();
    const token = changes.create();
    const reads = new ShadowMeshReads(changes);
    reads.add(token);
    const accepted = changes.epoch;
    const candidate = reads.retain();
    changes.retire(token);
    expect(changes.query(accepted, reads.generation, reads.tokens)).toBe('invalidated');
    reads.release();
    expect(token.owner).toBe(changes);
    expect(changes.query(accepted, candidate.generation, candidate.tokens)).toBe('invalidated');
    candidate.release();
    expect(token.owner).toBeUndefined();
    expect(token.previous).toBeUndefined();
    expect(token.next).toBeUndefined();
  });

  it('does not accumulate retired unrelated generations behind a held depth result', () => {
    const changes = new MeshChanges();
    const stable = changes.create();
    const reads = new ShadowMeshReads(changes);
    reads.add(stable);
    const accepted = changes.epoch;
    for (let generation = 0; generation < 1000; generation++) {
      const token = changes.create();
      changes.retire(token);
      expect(token.owner).toBeUndefined();
      expect(token.previous).toBeUndefined();
      expect(token.next).toBeUndefined();
    }
    expect(stable.previous).toBeUndefined();
    expect(stable.next).toBeUndefined();
    expect(changes.query(accepted, reads.generation, reads.tokens)).toBe('quiet');
    reads.release();
    changes.reset();
  });

  it('rejects mutation and dependency capture before reentrant ownership changes', () => {
    const changes = new MeshChanges();
    const watched = changes.create();
    const other = changes.create();
    const reads = new ShadowMeshReads(changes);
    reads.add(watched);
    const before = changes.epoch;
    changes.publish(watched);
    const has = vi.spyOn(reads.tokens, 'has').mockImplementationOnce(() => {
      expect(() => changes.publish(other)).toThrow('reenter');
      expect(() => reads.add(other)).toThrow('reenter');
      expect(() => reads.release()).toThrow('reenter');
      return true;
    });
    expect(changes.query(before, reads.generation, reads.tokens)).toBe('content');
    has.mockRestore();
    expect(reads.tokens.has(other)).toBe(false);
    expect(other.holders).toBe(1);
    reads.release();
    expect(watched.holders).toBe(1);
    changes.reset();
  });

  it('rolls back a failed Set insertion after retaining the native generation', () => {
    const changes = new MeshChanges();
    const token = changes.create();
    const reads = new ShadowMeshReads(changes);
    const add = reads.tokens.add.bind(reads.tokens);
    const fault = new Error('after native insertion');
    const injected = vi.spyOn(reads.tokens, 'add').mockImplementationOnce((entry) => {
      add(entry);
      throw fault;
    });
    expect(() => reads.add(token)).toThrow(fault);
    injected.mockRestore();
    expect(reads.tokens.has(token)).toBe(false);
    expect(token.holders).toBe(1);
    reads.release();
    expect(changes.owns(token)).toBe(true);
    changes.reset();
  });

  it('invalidates old proofs on reset and recovers an exhausted owner generation', () => {
    const changes = new MeshChanges();
    const token = changes.create();
    const reads = new ShadowMeshReads(changes);
    reads.add(token);
    const oldGeneration = reads.generation;
    (changes as unknown as { revision: number }).revision = Number.MAX_SAFE_INTEGER;
    expect(() => changes.preflight()).toThrow('exhausted');
    expect(reads.fixed).toBe(false);
    changes.reset();
    expect(changes.epoch).toBe(0);
    expect(changes.generation).not.toBe(oldGeneration);
    expect(changes.query(0, oldGeneration, reads.tokens)).toBe('invalidated');
    const current = changes.create();
    expect(changes.owns(current)).toBe(true);
    reads.release();
    expect(token.owner).toBeUndefined();
    changes.reset();
  });
});

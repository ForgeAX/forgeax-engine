import { expect, test } from 'vitest';
import { IdentityMap, IdentityMapEditor } from '../identity-map';

function contents(map: IdentityMap): Map<number, number> {
  const result = new Map<number, number>();
  map.forEach((entity, value) => {
    result.set(entity, value);
  });
  expect(new Map(map.entries())).toEqual(result);
  return result;
}

function random(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

test('sealed roots keep their contents while the editor keeps writing', () => {
  const next = random(7);
  const editor = new IdentityMapEditor();
  const reference = new Map<number, number>();
  const history: [IdentityMap, Map<number, number>][] = [];
  for (let round = 0; round < 16; round++) {
    for (let op = 0; op < 300; op++) {
      const entity = Math.floor(next() * 5000) + (next() < 0.05 ? 4294967296 * 2 : 0);
      if (next() < 0.35) {
        editor.delete(entity);
        reference.delete(entity);
      } else {
        const value = Math.floor(next() * 1e6);
        editor.set(entity, value);
        reference.set(entity, value);
      }
    }
    history.push([editor.capture(), new Map(reference)]);
  }
  for (const [map, expected] of history) {
    expect(map.size).toBe(expected.size);
    expect(contents(map)).toEqual(expected);
    for (const [entity, value] of expected) expect(map.get(entity)).toBe(value);
  }
});

test('an unchanged editor returns its sealed root and empty edits collapse', () => {
  const editor = new IdentityMapEditor();
  expect(editor.capture()).toBe(IdentityMap.EMPTY);
  editor.set(1, 2);
  const first = editor.capture();
  expect(editor.capture()).toBe(first);
  editor.delete(1);
  expect(editor.capture().size).toBe(0);
  expect(first.get(1)).toBe(2);
});

test('full numeric identities survive collisions, tombstones and leaf splits', () => {
  const editor = new IdentityMapEditor();
  for (let i = 0; i < 2048; i++) editor.set(i * 4294967296 + i, i);
  const before = editor.capture();
  for (let i = 0; i < 2048; i += 2) editor.delete(i * 4294967296 + i);
  const after = editor.capture();
  expect(before.size).toBe(2048);
  expect(after.size).toBe(1024);
  for (let i = 0; i < 2048; i++) {
    const entity = i * 4294967296 + i;
    expect(before.get(entity)).toBe(i);
    expect(after.get(entity)).toBe(i % 2 === 0 ? undefined : i);
  }
});

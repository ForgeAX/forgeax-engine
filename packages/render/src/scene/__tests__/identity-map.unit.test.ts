import { expect, test } from 'vitest';
import { IdentityMap, IdentityMapEditor } from '../identity-map';

function contents(map: IdentityMap): Map<string, number> {
  const result = new Map<string, number>();
  map.forEach((worldId, entity, value) => {
    result.set(`${worldId}:${entity}`, value);
  });
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
  const reference = new Map<string, number>();
  const history: [IdentityMap, Map<string, number>][] = [];
  for (let round = 0; round < 16; round++) {
    for (let op = 0; op < 300; op++) {
      const worldId = next() < 0.1 ? -1 - Math.floor(next() * 3) : Math.floor(next() * 3);
      const entity = Math.floor(next() * 5000) + (next() < 0.05 ? 4294967296 * 2 : 0);
      const key = `${worldId}:${entity}`;
      if (next() < 0.35) {
        editor.delete(worldId, entity);
        reference.delete(key);
      } else {
        const value = Math.floor(next() * 1e6);
        editor.set(worldId, entity, value);
        reference.set(key, value);
      }
    }
    history.push([editor.capture(), new Map(reference)]);
  }
  for (const [map, expected] of history) {
    expect(map.size).toBe(expected.size);
    expect(contents(map)).toEqual(expected);
    for (const [key, value] of expected) {
      const [worldId, entity] = key.split(':').map(Number) as [number, number];
      expect(map.get(worldId, entity)).toBe(value);
    }
  }
});

test('an unchanged editor returns its sealed root and empty edits collapse', () => {
  const editor = new IdentityMapEditor();
  expect(editor.capture()).toBe(IdentityMap.EMPTY);
  editor.set(0, 1, 2);
  const first = editor.capture();
  expect(editor.capture()).toBe(first);
  editor.delete(0, 1);
  const empty = editor.capture();
  expect(empty.size).toBe(0);
  expect(first.get(0, 1)).toBe(2);
});

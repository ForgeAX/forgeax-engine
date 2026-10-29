import { describe, expect, it } from 'vitest';
import { GameProjectSchema } from '../schema.js';

const valid = { id: 'game', name: 'Game', schemaVersion: '3.0.0', roots: {} };
const guid = '019fb7ce-4200-7000-8000-000000000000';
describe('project root assets', () => {
  it('allows an empty project and independent optional root assets', () => {
    expect(GameProjectSchema.parse(valid).roots).toEqual({});
    expect(
      GameProjectSchema.parse({ ...valid, roots: { build: guid, engine: guid, host: guid } }).roots,
    ).toEqual({ build: guid, engine: guid, host: guid });
  });
  it.each([
    'plugins',
    'defaultScene',
    'entry',
    'executionEntry',
    'physics',
    'npc',
  ])('rejects removed field %s', (field) => {
    expect(GameProjectSchema.safeParse({ ...valid, [field]: [] }).success).toBe(false);
  });
  it('requires roots, canonical GUIDs and the exact schema version', () => {
    const { roots: _roots, ...missing } = valid;
    for (const value of [
      missing,
      { ...valid, schemaVersion: '2.0.0' },
      { ...valid, roots: { engine: guid.toUpperCase() } },
      { ...valid, roots: { engine: null } },
      { ...valid, roots: { worker: guid } },
      { ...valid, roots: { engine: [guid] } },
    ]) {
      expect(GameProjectSchema.safeParse(value).success).toBe(false);
    }
  });
});

it('resolves authored asset directories with one manifest default', () => {
  expect(GameProjectSchema.parse(valid).assetRoots).toEqual(['assets']);
  expect(
    GameProjectSchema.parse({ ...valid, assetRoots: ['content/art', 'shared'] }).assetRoots,
  ).toEqual(['content/art', 'shared']);
  expect(GameProjectSchema.parse({ ...valid, assetRoots: [] }).assetRoots).toEqual([]);
});

it('rejects asset directories that are not portable project-relative paths', () => {
  for (const path of [
    '',
    '.',
    '..',
    '../outside',
    '/absolute',
    'C:/outside',
    'assets/../src',
    'assets//models',
    'assets/',
    'assets\\models',
    'assets/\0bad',
  ]) {
    expect(GameProjectSchema.safeParse({ ...valid, assetRoots: [path] }).success, path).toBe(false);
  }
});

it('mounts explicitly declared read-only asset libraries by package specifier', () => {
  expect(GameProjectSchema.parse(valid).assetLibraries).toEqual([]);
  expect(
    GameProjectSchema.parse({
      ...valid,
      assetLibraries: ['@forgeax/engine/content', '@studio/props', 'shared-kit'],
    }).assetLibraries,
  ).toEqual(['@forgeax/engine/content', '@studio/props', 'shared-kit']);
  for (const assetLibraries of [
    ['./vendor'],
    ['/absolute'],
    ['@studio/props/deep'],
    ['Upper'],
    ['@forgeax/engine/content', '@forgeax/engine/content'],
    [''],
  ]) {
    expect(
      GameProjectSchema.safeParse({ ...valid, assetLibraries }).success,
      JSON.stringify(assetLibraries),
    ).toBe(false);
  }
});

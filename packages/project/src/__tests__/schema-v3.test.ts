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

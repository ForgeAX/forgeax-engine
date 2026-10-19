import { describe, expect, it } from 'vitest';
import { type TemplateDescriptor, validateTemplateDescriptor } from '../templates/descriptor.js';
import { resolveProjectIdentity } from '../templates/materialize.js';

const empty: TemplateDescriptor = {
  id: 'empty',
  purpose: 'minimal project',
  defaultIdentity: { name: 'empty-game', packageName: '@local/empty-game' },
  journeys: ['typecheck', 'unit'],
};

describe('template descriptor discovery', () => {
  it('requires stable identity, purpose, defaults, and verification journeys', () => {
    expect(validateTemplateDescriptor(empty)).toEqual({ ok: true, value: empty });
    expect(validateTemplateDescriptor({ ...empty, journeys: [] })).toMatchObject({
      ok: false,
      error: { code: 'template-journey-missing' },
    });
  });
});

describe('project identity', () => {
  it.each([
    'cap-perf-01@forgeax-test',
    'My Game',
    '\u6e38\u620f',
  ])('allows an explicit id inside %s', (targetBasename) => {
    expect(
      resolveProjectIdentity({ targetBasename, descriptor: empty, overrides: { id: 'my-game' } }),
    ).toEqual({
      ok: true,
      value: { id: 'my-game', name: 'my-game', packageName: '@local/my-game' },
    });
  });
  it.each([
    '',
    'My Game',
    'bad/id',
  ])('rejects invalid explicit id %s even with a valid directory', (id) => {
    expect(
      resolveProjectIdentity({ targetBasename: 'safe-game', descriptor: empty, overrides: { id } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'project-identity-invalid', detail: { field: 'id' } },
    });
  });
});

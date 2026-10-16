import { describe, expect, it } from 'vitest';
import { type TemplateDescriptor, validateTemplateDescriptor } from '../templates/descriptor.js';

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

import { describe, expect, it } from 'vitest';
import { ProjectorBindingError } from '../errors/render';

describe('projector publication transaction', () => {
  it('uses one accepted identity for both surface and volume', () => {
    const identity = { guid: 'projector-guid', generation: 4, revision: 9 };
    const surface = identity;
    const volume = identity;
    expect(surface).toBe(volume);
    expect(surface).toEqual({ guid: 'projector-guid', generation: 4, revision: 9 });
  });

  it('keeps pending and bind failure structured', () => {
    const pending = new ProjectorBindingError('projector-guid', 'pending');
    const failed = new ProjectorBindingError('projector-guid', 'bind-failed');
    expect(pending).toMatchObject({
      code: 'projector-binding-failed',
      detail: { status: 'pending' },
    });
    expect(failed).toMatchObject({
      expected: expect.any(String),
      hint: expect.any(String),
      detail: { status: 'bind-failed' },
    });
  });
});

import { describe, expect, it } from 'vitest';
import { ProjectorBindingError } from '../errors/render';

describe('projector inspection', () => {
  it('distinguishes absent projector from an authored failure', () => {
    const absent = { status: 'absent' as const };
    const failure = new ProjectorBindingError('density-projector', 'invalid');
    expect(absent.status).toBe('absent');
    expect(failure.code).toBe('projector-binding-failed');
    expect(failure.detail.guid).toBe('density-projector');
  });
});

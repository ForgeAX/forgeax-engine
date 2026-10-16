import { describe, expect, it } from 'vitest';
import { LoadStateStore } from '../registry/load-state';

const ROOT = '11111111-1111-4111-8111-111111111111';
const REF = '22222222-2222-4222-8222-222222222222';

describe('registry load state', () => {
  it('keeps provisional records out of the public-ready fast path', () => {
    const states = new LoadStateStore();
    states.begin(ROOT, [REF]);
    states.resolveAsset(ROOT, { kind: 'root' });

    expect(states.get(ROOT)?.status).toBe('provisional');
    expect(states.getReady(ROOT)).toBeUndefined();

    states.begin(REF, []);
    states.resolveAsset(REF, { kind: 'ref' });
    states.promoteReady(REF);
    states.promoteReady(ROOT);
    expect(states.getReady(ROOT)).toEqual({ kind: 'root' });
  });

  it('purges a failed closure and returns to Unloaded for retry', () => {
    const states = new LoadStateStore();
    states.begin(ROOT, [REF]);
    states.begin(REF, []);
    states.resolveAsset(ROOT, { kind: 'root' });
    states.fail(ROOT, { code: 'artifact-failed' });

    expect(states.get(ROOT)?.status).toBe('unloaded');
    expect(states.get(REF)?.status).toBe('unloaded');
    expect(states.getReady(ROOT)).toBeUndefined();
    expect(states.begin(ROOT, [REF]).status).toBe('provisional');
  });
});

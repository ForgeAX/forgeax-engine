import { describe, expect, it } from 'vitest';
import { LoadStateStore } from '../registry/load-state';

const ROOT = '11111111-1111-4111-8111-111111111111';
const REF = '22222222-2222-4222-8222-222222222222';

describe('public-ready fast path', () => {
  it('returns only SCC-promoted values and never provisional or failed records', () => {
    const states = new LoadStateStore();
    states.begin(ROOT, [REF]);
    states.resolveAsset(ROOT, { kind: 'root' });
    expect(states.getReady(ROOT)).toBeUndefined();

    states.begin(REF, []);
    states.resolveAsset(REF, { kind: 'ref' });
    states.fail(REF, { code: 'missing-artifact' });
    expect(states.getReady(ROOT)).toBeUndefined();
    expect(states.getReady(REF)).toBeUndefined();

    states.begin(ROOT, [REF]);
    states.begin(REF, []);
    states.resolveAsset(REF, { kind: 'ref' });
    states.resolveAsset(ROOT, { kind: 'root' });
    states.promoteReady(REF);
    states.promoteReady(ROOT);
    expect(states.getReady(ROOT)).toEqual({ kind: 'root' });
  });

  it('purge removes the old failure so retry uses a new record', () => {
    const states = new LoadStateStore();
    states.begin(ROOT, []);
    states.fail(ROOT, { code: 'decode-failed' });
    expect(states.get(ROOT)?.status).toBe('unloaded');
    const retry = states.begin(ROOT, []);
    expect(retry.status).toBe('provisional');
    expect(retry.error).toBeUndefined();
  });
});

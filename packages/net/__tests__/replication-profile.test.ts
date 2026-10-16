import { describe, expect, it } from 'vitest';
import { defineComponent } from '@forgeax/engine-ecs';
import { defineReplication } from '../src/replication/profile';
import { validateHandshake } from '../src/replication/handshake';

const NetworkedProfile = defineComponent('NetworkedProfile', { enabled: 'bool' });
const PositionProfile = defineComponent('PositionProfile', { x: 'f32', y: 'f32' });
const VelocityProfile = defineComponent('VelocityProfile', { x: 'f32', y: 'f32' });

function profile(components = [NetworkedProfile, PositionProfile]) {
  return defineReplication({
    name: 'profile-test',
    entities: { with: [NetworkedProfile] },
    components,
    limits: {
      maxMessageBytes: 1024,
      maxEntities: 16,
      maxComponentOperations: 64,
      maxStringBytes: 64,
      maxBufferBytes: 256,
      maxArrayElements: 16,
    },
  });
}

describe('replication profile and handshake', () => {
  it('preserves ordered component selection in a deterministic fingerprint', () => {
    const first = profile();
    const second = profile();
    const reordered = profile([PositionProfile, NetworkedProfile]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(reordered.ok).toBe(true);
    if (!first.ok || !second.ok || !reordered.ok) return;

    expect(first.value.components).toEqual([NetworkedProfile, PositionProfile]);
    expect(first.value.fingerprint).toBe(second.value.fingerprint);
    expect(first.value.fingerprint).not.toBe(reordered.value.fingerprint);
  });

  it('accepts matching protocol, profile, and limits before decoding', () => {
    const local = profile();
    const remote = profile();
    expect(local.ok).toBe(true);
    expect(remote.ok).toBe(true);
    if (!local.ok || !remote.ok) return;

    expect(validateHandshake(local.value, remote.value).ok).toBe(true);
  });

  it('rejects profile mismatch with a structured handshake failure', () => {
    const local = profile();
    const remote = defineReplication({
      name: 'other-profile',
      entities: { with: [NetworkedProfile] },
      components: [NetworkedProfile, PositionProfile],
      limits: profile().ok ? profile().value.limits : undefined,
    });
    expect(local.ok).toBe(true);
    expect(remote.ok).toBe(true);
    if (!local.ok || !remote.ok) return;

    const result = validateHandshake(local.value, remote.value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('handshake-profile-mismatch');
    expect(result.error.expected).toContain('profile');
    expect(result.error.hint).not.toHaveLength(0);
  });

  it('rejects declared decode-limit mismatch before any batch is decoded', () => {
    const local = profile();
    const remote = defineReplication({
      name: 'profile-test',
      entities: { with: [NetworkedProfile] },
      components: [NetworkedProfile, PositionProfile, VelocityProfile],
      limits: {
        maxMessageBytes: 2048,
        maxEntities: 16,
        maxComponentOperations: 64,
        maxStringBytes: 64,
        maxBufferBytes: 256,
        maxArrayElements: 16,
      },
    });
    expect(local.ok).toBe(true);
    expect(remote.ok).toBe(true);
    if (!local.ok || !remote.ok) return;

    const result = validateHandshake(local.value, remote.value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('handshake-profile-mismatch');
    expect(result.error.detail).toMatchObject({ localFingerprint: local.value.fingerprint });
  });
});

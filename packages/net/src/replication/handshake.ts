import { err, ok, type Result } from '@forgeax/engine-types';
import { NetError } from './errors';
import type { ReplicationProfile } from './profile';
export function validateHandshake(
  local: ReplicationProfile,
  remote: ReplicationProfile,
): Result<void, NetError> {
  if (local.fingerprint !== remote.fingerprint)
    return err(
      new NetError({
        code: 'handshake-profile-mismatch',
        expected: 'matching protocol, profile, and declared limits',
        hint: 'use identical ordered replication components and limits on both peers',
        detail: { localFingerprint: local.fingerprint, remoteFingerprint: remote.fingerprint },
      }),
    );
  return ok(undefined);
}

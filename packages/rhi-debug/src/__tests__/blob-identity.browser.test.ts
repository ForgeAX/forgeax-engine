import { it } from 'vitest';
import { verifyBlobIdentity } from './blob-identity.fixture';

it('preserves colliding captured buffer payloads on a fresh WebGPU replay', verifyBlobIdentity);

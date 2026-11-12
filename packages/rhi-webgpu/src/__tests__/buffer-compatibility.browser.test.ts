import { it } from 'vitest';
import { verifyBufferCompatibility } from './buffer-compatibility.fixture';

it('preserves buffer semantics through a strict legacy native boundary', verifyBufferCompatibility);

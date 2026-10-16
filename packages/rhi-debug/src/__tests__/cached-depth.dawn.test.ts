import { it } from 'vitest';
import { verifyCachedDepth } from './cached-depth.fixture';

it('replays retained depth across array layers and mip levels', verifyCachedDepth);

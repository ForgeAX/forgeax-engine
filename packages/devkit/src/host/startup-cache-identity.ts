import { createHash } from 'node:crypto';
import type { StartupCacheIdentity } from './startup-cache-source.js';

/** Node generation owns hashing; the shared startup source also runs in browser tests. */
export function createStartupCacheIdentity(
  facts: Omit<StartupCacheIdentity, 'version'>,
): StartupCacheIdentity {
  const identity = {
    project: facts.project,
    game: facts.game,
    engine: facts.engine,
    ...(facts.revision === undefined ? {} : { revision: facts.revision }),
  };
  return {
    ...identity,
    version: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
  };
}

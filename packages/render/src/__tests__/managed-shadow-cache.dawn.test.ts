import { it } from 'vitest';
import { emit_reflection, parse, parseReflectionWire, validate } from '../../../naga/src/index';
import {
  SHADOW_CACHE_WITNESS,
  verifyManagedShadowCache,
} from './managed-shadow-recording.gpu-fixture';

it('retains native depth for unread parameter edits and adopts read fields over 60 completed frames', async () => {
  const module = (await validate((await parse(SHADOW_CACHE_WITNESS)).unwrap())).unwrap();
  try {
    const reflection = parseReflectionWire((await emit_reflection(module, '{}')).unwrap());
    if (reflection.entryPoints === undefined) throw new Error('Missing native entry reflection');
    await verifyManagedShadowCache(reflection.entryPoints);
  } finally {
    module.free();
  }
}, 120_000);

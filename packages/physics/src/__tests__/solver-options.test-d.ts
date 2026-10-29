import type { Context } from '@forgeax/engine-plugin';
import { expectTypeOf, test } from 'vitest';
import { definePhysicsPlugin, type PhysicsPluginBackend } from '../index.js';

declare const context: Context;
declare const backend: PhysicsPluginBackend;

test('native plugin configuration is optional and remains typed', () => {
  const physics = definePhysicsPlugin(backend);
  context.plugin(physics);
  context.plugin(physics, { solverIterations: 2 });
  expectTypeOf(physics.apply)
    .parameter(1)
    .toEqualTypeOf<{ readonly solverIterations?: number } | undefined>();
  // @ts-expect-error Solver precision must be numeric.
  context.plugin(physics, { solverIterations: '2' });
});

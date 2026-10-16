import type { RhiDevice } from '@forgeax/engine-rhi';
import { expectTypeOf } from 'vitest';
import type { ReplayBackend, ReplaySession, WorkInspection } from '../replay/session';

declare const device: RhiDevice;
declare const session: ReplaySession;

const backend: ReplayBackend = {
  device,
  createShaderModule: async () => {
    throw new Error('fixture');
  },
};

expectTypeOf(backend.createShaderModule).toBeFunction();
expectTypeOf(session.inspectWork(0)).resolves.toHaveProperty('ok');
expectTypeOf(session.readResourceAtWork('texture:out', 0)).resolves.toHaveProperty('ok');
expectTypeOf(session.dispose()).resolves.toHaveProperty('ok');
expectTypeOf<WorkInspection['pipeline']>().not.toBeNever();
expectTypeOf<WorkInspection['bindings']>().toMatchTypeOf<readonly unknown[] | undefined>();
expectTypeOf<WorkInspection['vertexBuffers']>().toMatchTypeOf<readonly unknown[] | undefined>();
expectTypeOf<WorkInspection['indexBuffer']>().not.toBeNever();
expectTypeOf<WorkInspection['shaders']>().toMatchTypeOf<readonly unknown[] | undefined>();
expectTypeOf<WorkInspection['resourceIds']>().toEqualTypeOf<readonly string[] | undefined>();

// @ts-expect-error ReplayBackend must not be constructible without shader creation.
const missingFactory: ReplayBackend = { device };
void missingFactory;

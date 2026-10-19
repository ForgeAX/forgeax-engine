import type { Buffer, RhiDevice, Texture } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { expectTypeOf } from 'vitest';
import type { RhiDebugError } from '../errors';
import type { ReplayExecutionContext } from '../replay/execute';
import { passCall, requireResource } from '../replay/execute-support';
import type { ResourceTable } from '../replay/resources';
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

declare const context: ReplayExecutionContext;
declare const table: ResourceTable;
declare const texture: Texture;

const buffer = requireResource(context, 'resource', 'buffer', 0, 'writeBuffer');
expectTypeOf(buffer).toEqualTypeOf<Result<Buffer, RhiDebugError>>();
// @ts-expect-error A buffer tag cannot publish a texture value.
table.set('resource', { kind: 'buffer', value: texture });
// @ts-expect-error Physical kinds are closed; the old role envelope has no typed value.
requireResource(context, 'resource', 'encoder', 0, 'finish');

passCall(
  context,
  { kind: 'setBindGroup', passHandleId: 'pass', bindGroupHandleId: 'group', index: 0 },
  0,
  'pass',
  (pass) => {
    // @ts-expect-error A shared pass operation cannot assume a render pass.
    pass.draw(3);
    return ok(undefined);
  },
);
passCall(
  context,
  {
    kind: 'draw',
    passHandleId: 'pass',
    vertexCount: 3,
    instanceCount: 1,
    firstVertex: 0,
    firstInstance: 0,
  },
  0,
  'render-pass',
  (pass) => {
    // @ts-expect-error A render pass never dispatches compute work.
    pass.dispatchWorkgroups(1);
    return ok(undefined);
  },
);

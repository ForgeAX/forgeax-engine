import type { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import type { RenderFeature } from '../features/types';

type Frame = {
  readonly count: number;
};

const feature = {
  identity: 'synthetic.context-boundary',
  extract(context) {
    const world: World = context.world;
    const frameNumber: number = context.frameNumber;
    void world;
    void frameNumber;

    // @ts-expect-error extract must not receive a prepare-stage runtime surface
    context.runtime;
    // @ts-expect-error extract must not receive a GPU command encoder
    context.encoder;
    return ok({ count: world.inspect().entityCount });
  },
  plan(data, context) {
    const count: number = data.count;
    const caps = context.caps;
    const targets = context.views.map((view) => view.targets);
    const frame = context.frame;
    const generation = context.generation;
    void count;
    void caps;
    void targets;
    void frame;
    void generation;

    // @ts-expect-error plan must not receive the live World collection
    context.worlds;
    // @ts-expect-error plan must not receive the complete pipeline context
    context.pipeline;
    // @ts-expect-error plan must not receive a raw device
    context.device;
    // @ts-expect-error plan must not expose a queue
    context.queue;
    // @ts-expect-error plan must not expose submit commands
    context.submit;
    // @ts-expect-error plan must not expose a command encoder
    context.encoder;
    // @ts-expect-error plan descriptors replace staging callbacks
    context.staging;
    // @ts-expect-error plan descriptors replace prepared graphics callbacks
    context.graphics;
    return ok({ work: [] });
  },
} satisfies RenderFeature<Frame>;

void feature;

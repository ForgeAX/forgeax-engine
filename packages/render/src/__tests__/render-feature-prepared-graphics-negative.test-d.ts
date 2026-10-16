import { ok } from '@forgeax/engine-types';
import type { RenderFeature } from '../index';

interface Frame {
  readonly count: number;
}

const feature = {
  identity: 'prepared.graphics.negative',
  extract: () => ok<Frame>({ count: 1 }),
  plan(data, context) {
    void data;
    void context.caps;
    void context.frame;
    void context.generation;
    void context.views.map((view) => view.targets);

    // @ts-expect-error plan descriptors cannot access a raw device
    context.device;
    // @ts-expect-error plan descriptors cannot access a command queue
    context.queue;
    // @ts-expect-error plan descriptors cannot access a command encoder
    context.encoder;
    // @ts-expect-error plan descriptors cannot issue submit work
    context.submit;
    // @ts-expect-error plan descriptors cannot access the full pipeline context
    context.pipelineContext;
    // @ts-expect-error plan descriptors replace prepared graphics callbacks
    context.graphics;
    // @ts-expect-error plan descriptors replace graph staging callbacks
    context.staging;
    return ok({ work: [] });
  },
} satisfies RenderFeature<Frame>;

void feature;

import type { AnimationGraph } from '@forgeax/engine-types';
import { expectTypeOf } from 'vitest';
import { defineAnimationGraph } from '../graph/define-animation-graph';

const graph = defineAnimationGraph((builder) =>
  builder.clip('019ffa97-9000-7000-8000-000000000013'),
);
if (graph.ok) expectTypeOf(graph.value).toMatchTypeOf<AnimationGraph>();

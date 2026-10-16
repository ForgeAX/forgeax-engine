import { createWorldContext, Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { defineAnimationGraph } from '../graph/define-animation-graph';
import { animationPlugin } from '../index';

describe('animation graph World chain', () => {
  it('registers systems on a real World schedule', async () => {
    const world = new World();
    await createWorldContext(world, [animationPlugin()]);
    expect(() => world.update(1 / 60)).not.toThrow();
    void Update;
  });

  it('keeps durable clip identity across graph rebuild and evaluation', () => {
    const guid = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
    const graph = defineAnimationGraph((builder) => builder.clip(guid));

    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.nodes[0]).toMatchObject({ type: 'clip', clip: guid });
  });
});

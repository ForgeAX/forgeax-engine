import { expect, it } from 'vitest';
import { snapshot } from '../../__tests__/gpu-driven-production-fixture';

it('classifies content changes using the row generation instead of the next entity column', async () => {
  const { SceneSlots } = await import('../scene-slots');
  const slots = new SceneSlots();
  const { entityKey: _entity, transform, ...content } = snapshot(1, 1);
  const write = (generation: number) =>
    slots.write(0, { entityKey: 1, generation, content, pose: transform.world });
  write(1);
  slots.write(1, { entityKey: 9, generation: 1, content, pose: transform.world });
  const before = slots.capture();
  write(1);
  const poseOnly = slots.capture();
  expect(poseOnly.contentEpoch).toBe(before.contentEpoch);
  write(9);
  expect(slots.capture().contentEpoch).not.toBe(poseOnly.contentEpoch);
});

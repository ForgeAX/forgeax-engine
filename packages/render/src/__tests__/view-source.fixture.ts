import { World } from '@forgeax/engine-ecs';
import { RenderViewFrameSource } from '../world/render-views';

/** Keep constructor defaults when a test stages only the fields relevant to its view. */
export function viewSourceFixture(
  input: Partial<{ [K in keyof RenderViewFrameSource]: RenderViewFrameSource[K] | undefined }>,
): RenderViewFrameSource {
  if (input instanceof RenderViewFrameSource) return input;
  const { canvas, attachment, targetExtent, ...fields } = input;
  const source = new (class extends RenderViewFrameSource {
    override get attachment() {
      return attachment ?? super.attachment;
    }
    override targetExtent(target: Parameters<RenderViewFrameSource['targetExtent']>[0]) {
      return targetExtent?.(target) ?? super.targetExtent(target);
    }
  })({ canvas: canvas ?? { width: 1, height: 1 } });
  source.world = new World();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) Reflect.set(source, key, value);
  }
  return source;
}

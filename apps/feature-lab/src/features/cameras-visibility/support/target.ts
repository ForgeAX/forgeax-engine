import type { App } from '@forgeax/engine/app';
import type { FrameReceipt, RenderTarget, RenderTargetDescriptor } from '@forgeax/engine/render';

export const TARGET_2D: RenderTargetDescriptor = {
  shape: '2d',
  width: 128,
  height: 128,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: true,
};

/** The App's next submitted frame receipt. */
export function nextReceipt(app: App): Promise<FrameReceipt> {
  return new Promise((resolve) => {
    const off = app.renderer.subscribe((event) => {
      if (event.kind !== 'frame-submitted') return;
      off();
      resolve(event.receipt);
    });
  });
}

/** One-shot readback bound to the App's next submitted frame; a string is a structured failure. */
export async function readTarget(
  app: App,
  target: RenderTarget,
  face?: number,
): Promise<Uint8Array | string> {
  const ticket = app.renderer.requestTargetReadback(
    target,
    face === undefined ? { mipLevel: 0 } : { mipLevel: 0, layer: face },
  );
  if (!ticket.ok) return `requestTargetReadback: ${ticket.error.code}`;
  const observed = await app.renderer.observe(await nextReceipt(app), {
    include: ['target-readbacks'],
    targetReadbacks: [ticket.value],
  });
  if (!observed.ok) return `observe: ${observed.error.code}`;
  const data = observed.value.targetReadbacks?.[0];
  return data === undefined ? 'no target readback returned' : data.bytes;
}

/** Mean RGBA8 color of a readback, each channel in [0, 1]. */
export function meanColor(bytes: Uint8Array): readonly [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const count = Math.max(1, bytes.length / 4);
  for (let at = 0; at < bytes.length; at += 4) {
    r += bytes[at] ?? 0;
    g += bytes[at + 1] ?? 0;
    b += bytes[at + 2] ?? 0;
  }
  return [r / count / 255, g / count / 255, b / count / 255];
}

/** Target plus sampled texture source, both as World shared refs; undefined when creation fails. */
export function sampledTarget(
  app: App,
  descriptor: RenderTargetDescriptor,
  dimension: '2d' | 'cube',
): { target: RenderTarget; targetRef: number; sourceRef: number } | undefined {
  const target = app.renderer.createRenderTarget(descriptor);
  if (!target.ok) return undefined;
  const source = app.renderer.createRenderTargetTextureSource(target.value, {
    aspect: 'color',
    dimension,
    mipLevel: 0,
  });
  if (!source.ok) return undefined;
  return {
    target: target.value,
    targetRef: app.world.allocSharedRef('RenderTarget', target.value) as unknown as number,
    sourceRef: app.world.allocSharedRef(
      'RenderTargetTextureSource',
      source.value,
    ) as unknown as number,
  };
}

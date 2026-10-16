import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  SNAPSHOT_CANVAS,
  verifyFramebufferSnapshot,
  verifyPublicationSnapshot,
} from './framebuffer-snapshot.fixture';
import { gbufferReplayIdentity, renderValue } from './standard-gbuffer-replay.fixture';

async function host(publicationSource?: { source: string; epoch: number }) {
  const canvas = document.createElement('canvas');
  canvas.width = SNAPSHOT_CANVAS;
  canvas.height = SNAPSHOT_CANVAS;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const built = renderValue(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      ssrIdentity: gbufferReplayIdentity,
      ...(publicationSource === undefined ? {} : { publicationSource }),
    }),
  );
  return {
    ...built,
    recorder,
    async dispose() {
      renderValue(await built.renderer.dispose());
      canvas.remove();
      (await recorder.dispose()).unwrap();
    },
  };
}

it('retains a frame-N scene-color region across 60 changed frames and replays the copy in Browser WebGPU', {
  timeout: 240_000,
}, async () => {
  const local = await host();
  let result: Awaited<ReturnType<typeof verifyFramebufferSnapshot>>;
  try {
    result = await verifyFramebufferSnapshot({
      renderer: local.renderer,
      recorder: local.recorder,
      save: () => undefined,
    });
  } finally {
    await local.dispose();
  }
  const identity = { source: 'framebuffer-snapshot', epoch: 1 };
  const published = await host(identity);
  let publication: Awaited<ReturnType<typeof verifyPublicationSnapshot>>;
  try {
    publication = await verifyPublicationSnapshot({
      renderer: published.renderer,
      assets: published.assets,
      identity,
    });
  } finally {
    await published.dispose();
  }
  await commands.writeFile(
    'artifacts/pr-evidence/framebuffer-snapshot/summary.browser.json',
    `${JSON.stringify(
      {
        backend: 'browser-webgpu',
        colorDomain: 'linear-hdr rgba16float scene color before post/tonemap',
        ...result,
        publication,
      },
      null,
      2,
    )}\n`,
  );
});

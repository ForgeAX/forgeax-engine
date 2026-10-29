import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminancePng, offscreenCanvas } from './hdr-evidence.fixture';
import { IES_TEST_SIZE, verifyLocalIes } from './ies-local-lights.fixture';
import { verifyLocalIesReplay } from './ies-local-lights-replay.fixture';
import { observeNativeDeviceRequests } from './native-device-work.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest({ pointShadows: true }));
const nativeDevices = observeNativeDeviceRequests();
async function createIesHost(publicationSource?: { source: string; epoch: number }) {
  const target = offscreenCanvas(IES_TEST_SIZE);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(
      target.canvas,
      {
        rhi: recorder.backend.rhi,
        ...(publicationSource === undefined ? {} : { publicationSource }),
      },
      { shaderManifestUrl: manifest },
    ),
  );
  return { target, recorder, host };
}
type IesHost = Awaited<ReturnType<typeof createIesHost>>;
let ordinaryHost: Promise<IesHost> | undefined;
async function disposeIesHost({ target, recorder, host }: IesHost) {
  renderValue(await host.renderer.dispose());
  target.destroy();
  (await recorder.dispose()).unwrap();
}
afterAll(async () => {
  try {
    if (ordinaryHost !== undefined) await disposeIesHost(await ordinaryHost);
    nativeDevices.assertMaximum(19);
  } finally {
    nativeDevices.restore();
  }
});

// Keep both paths and light kinds; the combined variants also own publication
// and shadow/source-texture composition, including the same IES pixel/replay checks.
for (const [path, kind, combined] of [
  ['forward', 'point', false],
  ['deferred', 'rect', false],
  ['deferred', 'point', true],
  ['forward', 'rect', true],
] as const) {
  it(`renders ${path} ${kind} IES ${combined ? 'with publication and shadow/source texture' : ''} with HDR and RHI replay`, {
    timeout: 180_000,
  }, async () => {
    const identity = { source: `ies-${kind}`, epoch: 1 };
    let fixture: IesHost;
    if (combined) fixture = await createIesHost(identity);
    else {
      ordinaryHost ??= createIesHost();
      fixture = await ordinaryHost;
    }
    const { recorder, host } = fixture;
    const directory = 'artifacts/ies-point-area/dawn';
    mkdirSync(directory, { recursive: true });
    const save = async (name: string, bytes: Uint8Array) => {
      writeFileSync(`${directory}/${name}`, bytes);
    };
    try {
      const samples = await verifyLocalIes(host.renderer, kind, path, {
        recorder,
        combined,
        ...(combined
          ? {
              publication: {
                assets: host.assets,
                identity,
              },
            }
          : {}),
        async capture(name, tape, image) {
          await save(`${name}.png`, luminancePng(image, IES_TEST_SIZE, 1));
          await save(`${name}.luminance-f32`, new Uint8Array(image.buffer));
          if (tape === undefined) return;
          await save(`${name}.rhitape`, tape.bytes);
          await verifyLocalIesReplay(name, tape, image, save);
        },
      });
      await save(
        `${path}-${kind}-${combined ? 'combined-' : ''}samples.json`,
        new TextEncoder().encode(JSON.stringify(samples, null, 2)),
      );
    } finally {
      if (combined) await disposeIesHost(fixture);
    }
  });
}

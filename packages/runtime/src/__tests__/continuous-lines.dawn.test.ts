import { mkdirSync, writeFileSync } from 'node:fs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { beforeAll, it } from 'vitest';
import { verifyContinuousLines } from './continuous-lines.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

let manifestUrl: string;
// Cold source compilation is preparation; CI reuses its validated shared inputs.
beforeAll(async () => {
  manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
}, 300_000);

it('renders continuous and dashed lines and proves RHI replay on Dawn', async () => {
  const directory = 'artifacts/continuous-lines/dawn';
  mkdirSync(directory, { recursive: true });
  await verifyContinuousLines({
    shaderManifestUrl: manifestUrl,
    save: (name, bytes) => {
      writeFileSync(`${directory}/${name}`, bytes);
    },
  });
}, 240_000);

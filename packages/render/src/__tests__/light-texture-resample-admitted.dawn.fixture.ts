import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import {
  type AdmittedLightTextureResamplePrograms,
  admitSerializedLightTextureResamplePrograms,
} from './light-texture-resample-admitted.fixture';

/** Admit the exact serialized engine manifest used by production Dawn fixtures. */
export async function loadBuiltLightTextureResamplePrograms(): Promise<AdmittedLightTextureResamplePrograms> {
  const manifest = await buildEngineShaderManifest();
  return admitSerializedLightTextureResamplePrograms(JSON.stringify(manifest), 'engine-built');
}

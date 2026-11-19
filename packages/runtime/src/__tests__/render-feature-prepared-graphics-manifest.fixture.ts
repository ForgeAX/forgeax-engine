import {
  nativeOutputShaderFixture,
  waterInfoShaderFixture,
} from '../../../render/src/__tests__/shader-manifest-fixture';
import { standardMaterialShaderVariants } from './helpers/standard-material-manifest';

/** Node integration owns its synthetic manifest; Browser consumes the admitted profile. */
export const preparedManifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    entries: [
      ...waterInfoShaderFixture.entries,
      ...nativeOutputShaderFixture.entries,
      { hash: 'pbr00000', wgsl: '/* pbr stub */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
    ],
    materialShaders: [
      ...waterInfoShaderFixture.materialShaders,
      ...nativeOutputShaderFixture.materialShaders,
      {
        identifier: 'forgeax::default-standard-pbr',
        sourcePath: 'forgeax::default-standard-pbr.wgsl',
        composedWgsl: '/* stub */',
        paramSchema: '[]',
        variants: standardMaterialShaderVariants(),
      },
    ],
  }),
)}`;

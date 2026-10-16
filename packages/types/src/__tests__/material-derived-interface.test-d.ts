import { describe, expectTypeOf, it } from 'vitest';
import type {
  DerivedMaterialInterface,
  MaterialParameterProjection,
  MaterialParameterResourceProjection,
} from '../derive-paramschema.js';
import type { MaterialAsset } from '../material/asset.js';

const numericProjection: MaterialParameterProjection = {
  kind: 'numeric',
  name: 'roughness',
  type: 'f32',
  member: {
    name: 'roughness',
    offset: 0,
    size: 4,
    alignment: 4,
    type: 'f32',
  },
};

const textureProjection: MaterialParameterProjection = {
  kind: 'texture',
  name: 'albedo',
  type: 'texture2d',
  coordinates: {
    parameter: 'albedo',
    offset: 0,
    size: 48,
    alignment: 16,
    transformMember: 'albedoCoordinatesTransform',
    metadataMember: 'albedoCoordinatesMetadata',
    rotationMember: 'albedoCoordinatesRotation',
  },
  resource: {
    parameter: 'albedo',
    texture: { name: 'albedo', binding: 2, kind: 'texture' },
    sampler: { name: 'albedo_sampler', binding: 1, kind: 'sampler' },
  },
};

const resourceProjection: MaterialParameterResourceProjection = {
  kind: 'storage-buffer',
  name: 'bones',
  type: 'storage_buffer',
  resource: { name: 'bones', binding: 3, kind: 'storage-buffer' },
};

describe('derived parameter projection types', () => {
  it('keeps compiler macro ownership out of MaterialAsset', () => {
    const material: MaterialAsset = {
      kind: 'material',
      parameters: [
        {
          name: 'clearcoat',
          type: 'bool',
          // @ts-expect-error static is not a Material runtime parameter axis
          static: true,
        },
      ],
    };
    void material;
  });

  it('exposes discriminated numeric, texture, and resource projections', () => {
    expectTypeOf(numericProjection.kind).toEqualTypeOf<'numeric'>();
    expectTypeOf(textureProjection.coordinates.size).toEqualTypeOf<48>();
    expectTypeOf(resourceProjection.kind).toMatchTypeOf<'sampler' | 'storage-buffer'>();
  });

  it('keeps all compiler-facing projections rooted in one derived interface', () => {
    expectTypeOf<MaterialParameterProjection['name']>().toBeString();
    expectTypeOf<DerivedMaterialInterface['layoutIdentity']>().toEqualTypeOf<string>();
  });

  it('rejects a numeric projection carrying texture-only facts', () => {
    // @ts-expect-error numeric parameters have no coordinate projection
    const invalid: MaterialParameterProjection = {
      kind: 'numeric',
      name: 'roughness',
      type: 'f32',
      coordinates: textureProjection.coordinates,
    };
    void invalid;
  });

  it('rejects a texture projection with an invalid resource kind', () => {
    const invalid: MaterialParameterProjection = {
      kind: 'texture',
      name: 'albedo',
      type: 'texture2d',
      // @ts-expect-error texture resources cannot be storage buffers
      resource: { name: 'albedo', binding: 2, kind: 'storage-buffer' },
    };
    void invalid;
  });
});

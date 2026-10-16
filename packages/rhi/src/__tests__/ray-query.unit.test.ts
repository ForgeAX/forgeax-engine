import { describe, expect, it } from 'vitest';
import type { Blas, Buffer, RhiRayQueryCaps, Tlas, TlasInstance } from '../index';
import {
  BLAS_INPUT_BUFFER_USAGE,
  RAY_QUERY_BACKEND_UNSUPPORTED,
  RAY_QUERY_WGSL_ENABLE,
  rayQueryUnsupported,
  validateBlasBuild,
  validateBlasDescriptor,
  validateRayQueryBindGroupLayout,
  validateRayQueryBufferUsage,
  validateRayQueryShader,
  validateTlasBuild,
  validateTlasDescriptor,
  wgslEnablesRayQuery,
} from '../index';

const SUPPORTED: RhiRayQueryCaps = {
  supported: true,
  maxBlasGeometryCount: 2,
  maxBlasPrimitiveCount: 4,
  maxTlasInstanceCount: 8,
  maxAccelerationStructuresPerShaderStage: 1,
};
const blas = {} as Blas;
const tlas = {} as Tlas;
const buffer = {} as Buffer;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function code(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe('wgslEnablesRayQuery', () => {
  it('detects the directive alone, in a list, and ignores comments or other extensions', () => {
    expect(wgslEnablesRayQuery(`${RAY_QUERY_WGSL_ENABLE}\nfn f() {}`)).toBe(true);
    expect(wgslEnablesRayQuery('enable f16, wgpu_ray_query;\n')).toBe(true);
    expect(wgslEnablesRayQuery('enable f16;\nfn f() {}')).toBe(false);
    expect(wgslEnablesRayQuery('// enable wgpu_ray_query;\n')).toBe(false);
    expect(wgslEnablesRayQuery('enable wgpu_ray_query_vertex_return;')).toBe(false);
  });
});

describe('capability gates', () => {
  it('unsupported caps refuse Ray Query shaders, layouts, and handles with feature-not-enabled', () => {
    const caps = RAY_QUERY_BACKEND_UNSUPPORTED;
    expect(Object.isFrozen(caps)).toBe(true);
    expect(code(validateRayQueryShader(caps, RAY_QUERY_WGSL_ENABLE))).toBe('feature-not-enabled');
    expect(validateRayQueryShader(caps, 'fn f() {}').ok).toBe(true);
    const layout = { entries: [{ binding: 3, visibility: 4, accelerationStructure: {} }] };
    const refused = validateRayQueryBindGroupLayout(caps, layout);
    expect(code(refused)).toBe('feature-not-enabled');
    if (!refused.ok) expect(refused.error.hint).toContain("reason='backend-has-no-ray-query'");
    expect(
      validateRayQueryBindGroupLayout(caps, {
        entries: [{ binding: 0, visibility: 4, buffer: {} }],
      }).ok,
    ).toBe(true);
    expect(code(validateBlasDescriptor(caps, { geometries: [] }))).toBe('feature-not-enabled');
    expect(code(validateTlasDescriptor(caps, { maxInstances: 1 }))).toBe('feature-not-enabled');
    expect(code(rayQueryUnsupported('createBlas', caps))).toBe('feature-not-enabled');
  });

  it('supported caps admit Ray Query shaders and layouts', () => {
    expect(validateRayQueryShader(SUPPORTED, RAY_QUERY_WGSL_ENABLE).ok).toBe(true);
    expect(
      validateRayQueryBindGroupLayout(SUPPORTED, {
        entries: [{ binding: 0, visibility: 4, accelerationStructure: {} }],
      }).ok,
    ).toBe(true);
  });
});

describe('descriptor validation', () => {
  it('admits triangle lists within the declared limits', () => {
    expect(
      validateBlasDescriptor(SUPPORTED, {
        geometries: [
          { vertexFormat: 'float32x3', vertexCount: 4, index: { format: 'uint16', count: 6 } },
          { vertexFormat: 'float32x3', vertexCount: 6 },
        ],
      }).ok,
    ).toBe(true);
    expect(validateTlasDescriptor(SUPPORTED, { maxInstances: 8 }).ok).toBe(true);
  });

  it('refuses empty, partial, oversized, and over-limit topology', () => {
    const tri = { vertexFormat: 'float32x3', vertexCount: 3 } as const;
    expect(code(validateBlasDescriptor(SUPPORTED, { geometries: [] }))).toBe(
      'rhi-descriptor-invalid',
    );
    expect(code(validateBlasDescriptor(SUPPORTED, { geometries: [tri, tri, tri] }))).toBe(
      'rhi-descriptor-invalid',
    );
    expect(
      code(
        validateBlasDescriptor(SUPPORTED, {
          geometries: [{ vertexFormat: 'float32x3', vertexCount: 4 }],
        }),
      ),
    ).toBe('rhi-descriptor-invalid');
    expect(
      code(
        validateBlasDescriptor(SUPPORTED, {
          geometries: [
            { vertexFormat: 'float32x3', vertexCount: 3, index: { format: 'uint32', count: 15 } },
          ],
        }),
      ),
    ).toBe('rhi-descriptor-invalid');
    expect(code(validateTlasDescriptor(SUPPORTED, { maxInstances: 0 }))).toBe(
      'rhi-descriptor-invalid',
    );
    expect(code(validateTlasDescriptor(SUPPORTED, { maxInstances: 9 }))).toBe(
      'rhi-descriptor-invalid',
    );
  });
});

describe('build validation', () => {
  const blasInput = () => BLAS_INPUT_BUFFER_USAGE | 0x8;
  const indexed = {
    geometries: [
      { vertexFormat: 'float32x3', vertexCount: 3, index: { format: 'uint16', count: 3 } },
    ],
  } as const;

  it('requires build geometries that match the creation-time declaration', () => {
    const good = {
      blas,
      geometries: [{ vertexBuffer: buffer, vertexStride: 12, index: { buffer } }],
    };
    expect(validateBlasBuild(indexed, good, blasInput).ok).toBe(true);
    expect(code(validateBlasBuild(indexed, { blas, geometries: [] }, blasInput))).toBe(
      'rhi-descriptor-invalid',
    );
    expect(
      code(
        validateBlasBuild(
          indexed,
          {
            blas,
            geometries: [{ vertexBuffer: buffer, vertexStride: 12 }],
          },
          blasInput,
        ),
      ),
    ).toBe('rhi-descriptor-invalid');
    expect(
      code(
        validateBlasBuild(
          indexed,
          {
            blas,
            geometries: [{ vertexBuffer: buffer, vertexStride: 14, index: { buffer } }],
          },
          blasInput,
        ),
      ),
    ).toBe('rhi-descriptor-invalid');
    const missing = validateBlasBuild(indexed, good, () => 0x20 | 0x10);
    expect(code(missing)).toBe('rhi-descriptor-invalid');
    expect(missing.ok ? '' : missing.error.hint).toContain('BLAS_INPUT_BUFFER_USAGE');
  });

  it('gates BLAS_INPUT_BUFFER_USAGE on caps.rayQuery', () => {
    expect(BLAS_INPUT_BUFFER_USAGE).toBe(1 << 10);
    expect(validateRayQueryBufferUsage(SUPPORTED, BLAS_INPUT_BUFFER_USAGE).ok).toBe(true);
    expect(validateRayQueryBufferUsage(RAY_QUERY_BACKEND_UNSUPPORTED, 0x28).ok).toBe(true);
    expect(
      code(validateRayQueryBufferUsage(RAY_QUERY_BACKEND_UNSUPPORTED, BLAS_INPUT_BUFFER_USAGE | 8)),
    ).toBe('feature-not-enabled');
  });

  it('checks TLAS capacity, transforms, custom index, and mask ranges', () => {
    const instance: TlasInstance = { blas, transform: IDENTITY, customIndex: 7, mask: 0xff };
    const desc = { maxInstances: 1 };
    expect(validateTlasBuild(desc, { tlas, instances: [instance] }).ok).toBe(true);
    expect(code(validateTlasBuild(desc, { tlas, instances: [instance, instance] }))).toBe(
      'rhi-descriptor-invalid',
    );
    for (const bad of [
      { ...instance, transform: IDENTITY.slice(0, 11) },
      { ...instance, transform: [...IDENTITY.slice(0, 11), Number.NaN] },
      { ...instance, customIndex: 1 << 24 },
      { ...instance, mask: 256 },
    ]) {
      expect(code(validateTlasBuild(desc, { tlas, instances: [bad] }))).toBe(
        'rhi-descriptor-invalid',
      );
    }
  });
});

import { describe, expect, it } from 'vitest';
import { isShaderProgramContract, isShaderReflection } from '../runtime-contracts.js';

describe('shader program publication contract', () => {
  it('reuses immutable reflection facts while rechecking mutable descendants and accessors', () => {
    const reflection = () => ({
      schemaVersion: 'shader-reflection/3',
      uvSetCount: 0,
      boundGlobals: [],
      entryPoints: [{ name: 'main', stage: 'fragment', bindings: [{ group: 0, binding: 0 }] }],
    });
    const freeze = <T>(value: T): T => {
      if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const shared = freeze(reflection());
    expect(isShaderReflection(shared)).toBe(true);
    expect(isShaderReflection(shared)).toBe(true);

    const shallow = Object.freeze(reflection());
    expect(isShaderReflection(shallow)).toBe(true);
    shallow.entryPoints[0]?.bindings.push({ group: 0, binding: 0 });
    expect(isShaderReflection(shallow)).toBe(false);

    let uvSetCount = 0;
    const accessor = Object.freeze({
      ...freeze(reflection()),
      get uvSetCount() {
        return uvSetCount;
      },
    });
    expect(isShaderReflection(accessor)).toBe(true);
    uvSetCount = -1;
    expect(isShaderReflection(accessor)).toBe(false);

    const invalid = freeze({ ...reflection(), uvSetCount: -1 });
    expect(isShaderReflection(invalid)).toBe(false);
    expect(isShaderReflection(invalid)).toBe(false);
  });

  it('keeps ignored cyclic metadata outside immutable reflection reuse', () => {
    const reflection: Record<string, unknown> = {
      schemaVersion: 'shader-reflection/3',
      uvSetCount: 0,
      boundGlobals: Object.freeze([]),
    };
    reflection.metadata = reflection;
    Object.freeze(reflection);
    expect(isShaderReflection(reflection)).toBe(true);
    expect(isShaderReflection(reflection)).toBe(true);
  });

  it('accepts source-published numeric and target-format facts', () => {
    expect(
      isShaderProgramContract({
        schemaVersion: 'shader-program-contract/1',
        colorTargets: [
          { location: 0, format: 'rgba32float', numericType: 'float' },
          { location: 1, format: 'rgba8unorm', numericType: 'float' },
        ],
        numerical: {
          intermediatePrecision: 'f32',
          outputRange: [0, 1],
          reduction: 'box2x2-mean',
          mipLevelCount: 9,
          quantization: 'unorm8',
        },
      }),
    ).toBe(true);
  });

  it('rejects duplicate target locations and invalid numerical ranges', () => {
    const base = {
      schemaVersion: 'shader-program-contract/1',
      colorTargets: [
        { location: 0, format: 'rgba32float', numericType: 'float' },
        { location: 0, format: 'rgba8unorm', numericType: 'float' },
      ],
      numerical: { outputRange: [1, 0] },
    };
    expect(isShaderProgramContract(base)).toBe(false);
    expect(
      isShaderProgramContract({
        schemaVersion: 'shader-program-contract/1',
        numerical: { outputRange: [1, 0] },
      }),
    ).toBe(false);
  });

  it('retains and validates reflected buffer element types', () => {
    const reflection = {
      schemaVersion: 'shader-reflection/3',
      uvSetCount: 0,
      boundGlobals: [
        {
          group: 0,
          binding: 2,
          addressSpace: 'storage',
          resourceKind: 'storage-buffer',
          visibility: 4,
          members: [],
          span: 0,
          elementStride: 16,
          elementType: 'vec4<f32>',
          typeDescriptor: {
            kind: 'array',
            size: { kind: 'dynamic' },
            stride: 16,
            byteSize: 16,
            alignment: 16,
            element: {
              kind: 'vector',
              scalarKind: 'float',
              width: 4,
              components: 4,
              byteSize: 16,
              alignment: 16,
            },
          },
        },
      ],
    };
    expect(isShaderReflection(reflection)).toBe(true);
    expect(
      isShaderReflection({
        ...reflection,
        boundGlobals: [{ ...reflection.boundGlobals[0], elementType: '' }],
      }),
    ).toBe(false);
  });

  it.each([
    ['missing recursive descriptor', { typeDescriptor: undefined }],
    [
      'zero vector alignment',
      {
        typeDescriptor: {
          kind: 'array',
          size: { kind: 'dynamic' },
          stride: 16,
          byteSize: 16,
          alignment: 16,
          element: {
            kind: 'vector',
            scalarKind: 'float',
            width: 4,
            components: 4,
            byteSize: 16,
            alignment: 0,
          },
        },
      },
    ],
    [
      'array stride smaller than reflected element layout',
      {
        elementStride: 8,
        typeDescriptor: {
          kind: 'array',
          size: { kind: 'dynamic' },
          stride: 8,
          byteSize: 8,
          alignment: 16,
          element: {
            kind: 'vector',
            scalarKind: 'float',
            width: 4,
            components: 4,
            byteSize: 16,
            alignment: 16,
          },
        },
      },
    ],
  ])('rejects %s', (_label, patch) => {
    const global: Record<string, unknown> = {
      group: 0,
      binding: 2,
      addressSpace: 'storage',
      resourceKind: 'storage-buffer',
      visibility: 4,
      members: [],
      span: 0,
      elementStride: 16,
      elementType: 'vec4<f32>',
      typeDescriptor: {
        kind: 'array',
        size: { kind: 'dynamic' },
        stride: 16,
        byteSize: 16,
        alignment: 16,
        element: {
          kind: 'vector',
          scalarKind: 'float',
          width: 4,
          components: 4,
          byteSize: 16,
          alignment: 16,
        },
      },
    };
    Object.assign(global, patch);
    const reflection = {
      schemaVersion: 'shader-reflection/3',
      uvSetCount: 0,
      boundGlobals: [global],
    };
    expect(isShaderReflection(reflection)).toBe(false);
  });

  it('rejects a matrix column stride inconsistent with Naga row layout', () => {
    const member = {
      name: 'value',
      type: 'mat3x2<f32>',
      offset: 0,
      size: 48,
      alignment: 8,
      typeDescriptor: {
        kind: 'matrix',
        scalarKind: 'float',
        width: 4,
        columns: 3,
        rows: 2,
        columnStride: 16,
        byteSize: 48,
        alignment: 8,
      },
    };
    expect(
      isShaderReflection({
        schemaVersion: 'shader-reflection/3',
        uvSetCount: 0,
        boundGlobals: [
          {
            group: 0,
            binding: 0,
            addressSpace: 'uniform',
            resourceKind: 'buffer',
            visibility: 2,
            members: [member],
            span: 48,
            typeDescriptor: {
              kind: 'struct',
              span: 48,
              byteSize: 48,
              alignment: 8,
              members: [member],
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects an array size product that exceeds safe integer range', () => {
    expect(
      isShaderReflection({
        schemaVersion: 'shader-reflection/3',
        uvSetCount: 0,
        boundGlobals: [
          {
            group: 0,
            binding: 0,
            addressSpace: 'storage',
            resourceKind: 'storage-buffer',
            visibility: 4,
            members: [],
            span: 0,
            elementStride: 4,
            arrayLength: Number.MAX_SAFE_INTEGER,
            typeDescriptor: {
              kind: 'array',
              size: { kind: 'constant', count: Number.MAX_SAFE_INTEGER },
              stride: 4,
              byteSize: Number.MAX_SAFE_INTEGER,
              alignment: 4,
              element: {
                kind: 'scalar',
                scalarKind: 'float',
                width: 4,
                byteSize: 4,
                alignment: 4,
              },
            },
          },
        ],
      }),
    ).toBe(false);
  });
});

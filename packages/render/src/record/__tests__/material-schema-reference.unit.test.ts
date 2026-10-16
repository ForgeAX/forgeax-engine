import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { derive, ParamSchemaProjectionOwner } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { packMaterialProgramRow } from '../../material-row';
import type { MaterialSnapshot } from '../../render-system-extract';
import {
  applyMaterialTextureUvScales,
  applyParamSchemaDefaultsToUbo,
  writePbrMaterialUboPayload,
} from '../main-pass-material';

function snapshot(): MaterialSnapshot {
  return {
    baseColor: vec3.create(0.7, 0.2, 0.1),
    metallic: 0.2,
    roughness: 0.4,
    materialShaderId: 'forgeax::default-standard-pbr',
    materialParamSchema: structuredClone(STANDARD_PIPELINE_PARAM_SCHEMA).map((entry) => ({
      ...entry,
    })),
  };
}

it('uses the admitted ABI without hashing a transport copy and retains its authored defaults', () => {
  const material = snapshot();
  const schema = material.materialParamSchema;
  if (schema === undefined) throw new Error('missing source schema');
  const clearcoat = schema.find((entry) => entry.name === 'clearcoat');
  if (clearcoat === undefined) throw new Error('missing Standard clearcoat field');
  const member = derive(STANDARD_PIPELINE_PARAM_SCHEMA).numericMembers.find(
    (entry) => entry.name === 'clearcoat',
  );
  if (member === undefined) throw new Error('missing Standard clearcoat offset');
  Object.assign(clearcoat, { default: 0.75 });
  const stringify = JSON.stringify;
  let hashes = 0;
  const observer = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
    if (value && typeof value === 'object' && 'bglEntries' in value && 'bindingSpans' in value)
      hashes++;
    return stringify(value, replacer as never, space);
  });
  try {
    const payload = new Float32Array(512);
    writePbrMaterialUboPayload(payload, material);
    applyMaterialTextureUvScales(payload, material, new World());
    expect(hashes).toBe(0);
    expect(payload[member.offset / 4]).toBe(0.75);
    expect(payload[0]).toBeCloseTo(0.7);
  } finally {
    observer.mockRestore();
  }
});

it('recaptures a changed schema in the UV consumer after the UBO getter has run', () => {
  const initial = snapshot();
  const schema = initial.materialParamSchema;
  if (schema === undefined) throw new Error('missing source schema');
  const texture = schema.find((entry) => entry.name === 'baseColorTexture');
  if (texture === undefined) throw new Error('missing Standard coordinate field');
  const member = derive(STANDARD_PIPELINE_PARAM_SCHEMA).numericMembers.find(
    (entry) => entry.name === 'clearcoat',
  );
  if (member === undefined) throw new Error('missing Standard clearcoat offset');
  const trace: string[] = [];
  const material: MaterialSnapshot = {
    ...initial,
    paramSnapshot: {
      get clearcoat() {
        trace.push('clearcoat');
        Object.assign(texture, { name: 'replacement' });
        return 0.5;
      },
    },
    textureCoordinates: new Map([
      ['replacement', { set: 2, transform: { offset: [0, 0], scale: [1, 1], rotation: 0 } }],
    ]),
  };
  const payload = new Float32Array(512);
  writePbrMaterialUboPayload(payload, material);
  applyMaterialTextureUvScales(payload, material, new World());
  const coordinate = derive(schema).coordinateRecords.find(
    (entry) => entry.parameter === 'replacement',
  );
  if (coordinate === undefined) throw new Error('missing changed coordinate field');
  expect(payload[coordinate.offset / 4 + 4]).toBe(2);
  expect(payload[member.offset / 4]).toBe(0.5);
  expect(trace).toEqual(['clearcoat']);
});

it.each([
  0,
  -0,
  Math.PI / 2,
  -Math.PI / 3,
  0.713,
])('shares CPU coordinate coefficients between direct and scene-index materials: %s', (rotation) => {
  const schema = [{ name: 'baseColorTexture', type: 'texture2d' }] as const;
  const material: MaterialSnapshot = {
    ...snapshot(),
    materialParamSchema: schema,
    textureCoordinates: new Map([
      [
        'baseColorTexture',
        { set: 7, transform: { offset: [0.2, -0.3], scale: [-2, 0.5], rotation } },
      ],
    ]),
  };
  const derived = derive(schema);
  const direct = new Float32Array(derived.totalBytes / 4);
  applyMaterialTextureUvScales(direct, material, new World());
  const packed = packMaterialProgramRow(schema, material, derived.totalBytes);
  if (packed === undefined) throw new Error('missing scene material row');
  expect(new Uint8Array(direct.buffer)).toEqual(packed);
  expect([...direct.slice(0, 8)]).toEqual([
    Math.fround(0.2),
    Math.fround(-0.3),
    -2,
    0.5,
    7,
    Math.fround(rotation),
    1,
    1,
  ]);
  expect(direct[8]).toBeCloseTo(Math.cos(rotation), 6);
  expect(direct[9]).toBeCloseTo(Math.sin(rotation), 6);
});

it('writes admitted defaults identically to mutable defaults with numeric WGSL encodings', () => {
  const schema = [
    { name: 'color', type: 'vec4', default: [0.25, 0.5, 0.75, 1] },
    { name: 'flags', type: 'u32', default: 0xdeadbeef },
    { name: 'signed', type: 'i32', default: -12345 },
    { name: 'unused', type: 'texture2d' },
  ] as const;
  const admitted = new ParamSchemaProjectionOwner().admit({ ownerId: 'test', revision: 1, schema });
  const raw = new Uint8Array(2048).fill(0x5a);
  const owned = raw.slice();
  applyParamSchemaDefaultsToUbo(raw, schema);
  applyParamSchemaDefaultsToUbo(owned, admitted.schema);
  expect(owned).toEqual(raw);
  const view = new DataView(owned.buffer);
  const flags = derive(schema).uboLayout.entries.find((entry) => entry.name === 'flags');
  if (flags === undefined) throw new Error('missing flags field');
  expect(view.getUint32(flags.offset, true)).toBe(0xdeadbeef);
});

it('captures all base color getter values before writing and preserves offset scratch views', () => {
  const material = snapshot();
  const trace: number[] = [];
  let reads = 0;
  Object.defineProperty(material, 'baseColor', {
    configurable: true,
    get() {
      trace.push(reads++);
      return [0.25, 0.5, 0.75];
    },
  });
  const storage = new Uint8Array(2304).fill(0x5a);
  const payload = new Float32Array(storage.buffer, 128, 512);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  writePbrMaterialUboPayload(payload, material, view);
  expect(trace).toEqual([0, 1, 2]);
  expect([...payload.subarray(0, 4)]).toEqual([0.25, 0.5, 0.75, 1]);
  expect(storage.subarray(0, 128)).toEqual(new Uint8Array(128).fill(0x5a));
  expect(storage.subarray(2176)).toEqual(new Uint8Array(128).fill(0x5a));
  Object.defineProperty(material, 'baseColor', {
    configurable: true,
    get() {
      throw new Error('late color');
    },
  });
  expect(() => writePbrMaterialUboPayload(payload, material, view)).toThrow('late color');
  expect(payload[0]).toBe(0);
});

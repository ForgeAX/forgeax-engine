import { describe, expect, it } from 'vitest';
import {
  boundGeometryObservationMetadata,
  captureGeometrySource,
  decodeGeometryCommands,
  decodeGeometryView,
  GEOMETRY_OBSERVATION_MAX_BYTES,
  GEOMETRY_OBSERVATION_MAX_COMMANDS,
  type GeometryCommandCapture,
  type GeometryObservation,
} from '../geometry-observation';

function fixture() {
  const bytes = new DataView(new ArrayBuffer(384));
  const source = (ordinal: number) => ({
    worldIdentity: 'world',
    entityKey: 31,
    primitiveSlot: 2,
    slotGeneration: 4,
    meshHandle: 81,
    meshGuid: 'actual-mesh',
    sourceKey: 'cluster/a',
    sourceRevision: 17,
    drawItemIndex: 3,
    materialSlot: 2,
    instanceOrdinal: ordinal,
  });
  const sources = new Map(Array.from({ length: 6 }, (_, i) => [100 + i, source(i)]));
  const base: GeometryCommandCapture = {
    pass: 'opaque:fs_gbuffer',
    phase: 'early',
    level: 0,
    batchId: 9,
    indirectOffset: 0,
    visibleBase: 0,
    bufferIdentity: 7,
    kind: 'indexed',
    topology: 'triangle-list',
    sources,
  };
  // Final first region is union=6, though only its early prefix=2 was drawn.
  for (const [offset, instances] of [
    [0, 6],
    [20, 4],
  ] as const) {
    bytes.setUint32(offset, 36, true);
    bytes.setUint32(offset + 4, instances, true);
    bytes.setUint32(offset + 8, 12, true);
    bytes.setInt32(offset + 12, -4, true);
  }
  for (let i = 0; i < 6; i++) bytes.setUint32(40 + i * 16, 100 + i, true);
  for (let i = 0; i < 4; i++) bytes.setUint32(40 + (6 + i) * 16, 102 + i, true);
  bytes.setUint32(360, 2, true);
  return {
    bytes,
    base,
    input: {
      bytes,
      commands: [base, { ...base, phase: 'late' as const, indirectOffset: 20, visibleBase: 6 }],
      indirectBytes: 40,
      visibleBytes: 320,
      countersOffset: 360,
      earlyCountOffsets: new Map([['9:0', 0]]),
      firstInstanceIndirect: false,
    },
  };
}
describe('same-submit geometry decoding', () => {
  it('keeps small legacy observations byte-for-byte inline', () => {
    const commands = decodeGeometryCommands(fixture().input);
    const input: GeometryObservation = {
      scope: 'primary-display-view-gpu-commands',
      otherViews: 'unobserved',
      shadows: 'unobserved',
      cpuDraws: 'unobserved',
      featureDraws: 'unobserved',
      status: 'complete',
      frameId: 3,
      deviceGeneration: 2,
      commands,
      commandCount: commands.length,
      indexOrVertexWork: 216,
    };
    expect(boundGeometryObservationMetadata(input)).toBe(input);
    expect(input).not.toHaveProperty('identityTables');
  });
  it('losslessly interns repeated ABI and publication metadata inside the original byte limit', () => {
    const command = decodeGeometryCommands(fixture().input)[0];
    if (command === undefined) throw Error('Missing decoded command');
    const program = {
      scope: 'selected-gpu-driven-gbuffer-artifact' as const,
      material: 'material',
      pass: 'Deferred',
      programIdentity: 'composer',
      artifactSourceSha256: `sha256:${'a'.repeat(64)}`,
      specializationKey: null,
      layoutIdentity: 'layout'.repeat(4000),
      receiptIdentity: 'abi'.repeat(4000),
      receiptGeneration: 2,
      vertexEntry: 'vs_scene_index',
      fragmentEntry: 'fs_gbuffer',
      pipelineIdentity: 71,
      nativeShader: 'unobserved' as const,
    };
    const publication = {
      materialGuid: 'mat',
      publicationGeneration: 8,
      specializationKey: 'key',
      artifactHash: 'hash',
    };
    const commands = Array.from({ length: 80 }, (_, i) => ({
      ...command,
      batchId: i,
      gbufferProgram: { ...program, pipelineIdentity: i % 2 ? 72 : 71 },
      members: command.members.map((member) => ({
        ...member,
        materialHandle: 19,
        materialPublication: publication,
      })),
    }));
    const input: GeometryObservation = {
      scope: 'primary-display-view-gpu-commands',
      otherViews: 'unobserved',
      shadows: 'unobserved',
      cpuDraws: 'unobserved',
      featureDraws: 'unobserved',
      status: 'complete',
      frameId: 3,
      deviceGeneration: 2,
      commands,
      commandCount: commands.length,
      indexOrVertexWork: commands.reduce((sum, row) => sum + row.indexOrVertexWork, 0),
    };
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(
      GEOMETRY_OBSERVATION_MAX_BYTES,
    );
    const output = structuredClone(boundGeometryObservationMetadata(input));
    expect(new TextEncoder().encode(JSON.stringify(output)).byteLength).toBeLessThanOrEqual(
      GEOMETRY_OBSERVATION_MAX_BYTES,
    );
    expect(output.identityTables?.gbufferPrograms).toHaveLength(2);
    expect(output.identityTables?.materialPublications).toEqual([publication]);
    const expanded = output.commands.map(({ gbufferProgramId, ...row }) => ({
      ...row,
      gbufferProgram: output.identityTables?.gbufferPrograms[gbufferProgramId ?? -1],
      members: row.members.map(({ materialPublicationId, ...member }) => ({
        ...member,
        materialPublication:
          output.identityTables?.materialPublications[materialPublicationId ?? -1],
      })),
    }));
    expect(expanded).toEqual(input.commands);
    expect(input.commands[0]).not.toHaveProperty('gbufferProgramId');
    const failed = boundGeometryObservationMetadata({
      ...input,
      viewKey: 'x'.repeat(GEOMETRY_OBSERVATION_MAX_BYTES),
    });
    expect(failed).toMatchObject({
      status: 'unavailable',
      reason: 'metadata-budget',
      metadataEncoding: {
        attemptedCommandCount: 80,
        attemptedMemberCount: 160,
        programIdentityCount: 2,
        materialPublicationIdentityCount: 1,
      },
    });
    expect(failed.metadataEncoding?.tableBytes).toBeGreaterThan(GEOMETRY_OBSERVATION_MAX_BYTES);
    expect(failed.commands).toEqual([]);
  });
  it('separates early prefix from final union and late region without double counting', () => {
    const f = fixture(),
      r = decodeGeometryCommands(f.input);
    expect(r.map((x) => x.instanceCount)).toEqual([2, 4]);
    expect(r.map((x) => x.indexOrVertexWork)).toEqual([72, 144]);
    expect(r[0]?.baseVertex).toBe(-4);
    expect(r[0]?.first).toBe(12);
    expect(r.flatMap((x) => x.members.map((m) => m.instanceOrdinal))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r[0]?.members[0]).toMatchObject({
      meshGuid: 'actual-mesh',
      drawItemIndex: 3,
      materialSlot: 2,
      sourceRevision: 17,
    });
  });
  it('carries captured material and selected GBuffer identity through actual visible-row decoding', () => {
    const f = fixture();
    const publication = Object.freeze({
      materialGuid: 'material/a',
      publicationGeneration: 3,
      specializationKey: 'accepted-key',
      artifactHash: 'accepted-artifact',
    });
    const first = f.base.sources.get(100);
    if (first === undefined) throw Error('Missing source fixture');
    const sources = new Map(f.base.sources);
    sources.set(100, { ...first, materialHandle: 91, materialPublication: publication });
    const gbufferProgram = Object.freeze({
      scope: 'selected-gpu-driven-gbuffer-artifact' as const,
      material: 'selected-material',
      pass: 'Deferred',
      programIdentity: 'scene-index-program',
      artifactSourceSha256: `sha256:${'a'.repeat(64)}`,
      specializationKey: 'scene-key',
      layoutIdentity: 'layout',
      receiptIdentity: 'receipt',
      receiptGeneration: 7,
      vertexEntry: 'vs_scene_index',
      fragmentEntry: 'fs_gbuffer',
      pipelineIdentity: 52,
      nativeShader: 'unobserved' as const,
    });
    f.input.commands = [{ ...f.base, sources, gbufferProgram }];
    const command = decodeGeometryCommands(f.input)[0];
    if (command === undefined) throw Error('Missing decoded command');
    expect(command.gbufferProgram).toEqual(gbufferProgram);
    expect(command.members[0]).toMatchObject({
      materialHandle: 91,
      materialPublication: publication,
    });
    expect(command.members).toHaveLength(2);
    expect(structuredClone(command)).toEqual(command);
    expect(command.gbufferProgram?.specializationKey).not.toBe(publication.specializationKey);
    expect(decodeGeometryCommands(fixture().input)[0]).not.toHaveProperty('gbufferProgram');
  });
  it('rejects material publication ambiguity instead of borrowing a neighboring visible source', () => {
    const f = fixture(),
      source = f.base.sources.get(100);
    if (source === undefined) throw Error('Missing source fixture');
    const sources = new Map<number, typeof source>();
    captureGeometrySource(sources, 100, { ...source, materialHandle: 11 });
    expect(() => captureGeometrySource(sources, 100, { ...source, materialHandle: 12 })).toThrow(
      'ambiguous-instance-source',
    );
    const publication = {
      materialGuid: 'm',
      publicationGeneration: 1,
      specializationKey: 'key',
      artifactHash: 'hash',
    };
    const published = new Map<number, typeof source>();
    captureGeometrySource(published, 100, { ...source, materialPublication: publication });
    expect(() =>
      captureGeometrySource(published, 100, {
        ...source,
        materialPublication: { ...publication, publicationGeneration: 2 },
      }),
    ).toThrow('ambiguous-instance-source');
  });
  it('counts all actual command executions even when a buffer offset or batch is reused by another pass', () => {
    const f = fixture();
    f.input.commands = [
      { ...f.base, phase: 'all' },
      { ...f.base, phase: 'all', pass: 'forward:fs_main' },
    ];
    const r = decodeGeometryCommands(f.input);
    expect(r.reduce((n, x) => n + x.indexOrVertexWork, 0)).toBe(432);
  });
  it('zero-count and zero-instance commands do no geometry work', () => {
    const f = fixture();
    f.bytes.setUint32(0, 0, true);
    f.bytes.setUint32(24, 0, true);
    expect(
      decodeGeometryCommands(f.input).map((c) => [c.indexOrVertexWork, c.members.length]),
    ).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
  it('decodes the non-indexed first-instance word separately', () => {
    const f = fixture();
    f.input.commands = [{ ...f.base, kind: 'non-indexed', phase: 'all' }];
    f.bytes.setUint32(12, 0, true);
    expect(decodeGeometryCommands(f.input)[0]).toMatchObject({
      firstInstance: 0,
      baseVertex: 0,
      count: 36,
      instanceCount: 6,
    });
  });
  it.each([
    'indexed',
    'non-indexed',
  ] as const)('checks %s firstInstance against both visible-buffer binding modes', (kind) => {
    for (const firstInstanceIndirect of [false, true]) {
      const f = fixture();
      f.input.firstInstanceIndirect = firstInstanceIndirect;
      f.input.commands = [{ ...f.base, kind, phase: 'late', indirectOffset: 20, visibleBase: 6 }];
      const word = 20 + (kind === 'indexed' ? 16 : 12);
      const expected = firstInstanceIndirect ? 6 : 0;
      f.bytes.setUint32(word, expected, true);
      expect(decodeGeometryCommands(f.input)[0]?.members.map((m) => m.instanceOrdinal)).toEqual([
        2, 3, 4, 5,
      ]);
      f.bytes.setUint32(word, expected + 1, true);
      expect(() => decodeGeometryCommands(f.input)).toThrow('first-instance-mismatch');
    }
  });
  it('rejects unknown instance rows and mismatched early counters instead of borrowing the nearest source', () => {
    const f = fixture();
    f.bytes.setUint32(40, 999, true);
    expect(() => decodeGeometryCommands(f.input)).toThrow('source-unavailable');
    f.bytes.setUint32(40, 100, true);
    f.bytes.setUint32(360, 7, true);
    expect(() => decodeGeometryCommands(f.input)).toThrow('early-counter-mismatch');
  });
  it('rejects missing early counters, out of range indirect data and command-budget overflow', () => {
    const f = fixture();
    f.input.earlyCountOffsets.clear();
    expect(() => decodeGeometryCommands(f.input)).toThrow('early-counter-unavailable');
    f.input.commands = [{ ...f.base, phase: 'all', indirectOffset: 40 }];
    expect(() => decodeGeometryCommands(f.input)).toThrow('indirect-range');
    f.input.commands = Array.from({ length: GEOMETRY_OBSERVATION_MAX_COMMANDS + 1 }, () => f.base);
    expect(() => decodeGeometryCommands(f.input)).toThrow('command-budget');
  });
});

it('rejects ambiguous visible-row attribution to different source submeshes', () => {
  const f = fixture();
  const original = f.base.sources.get(100);
  if (original === undefined) throw Error('Missing source');
  const sources = new Map([[100, original]]);
  captureGeometrySource(sources, 100, { ...original });
  expect(() =>
    captureGeometrySource(sources, 100, { ...original, drawItemIndex: original.drawItemIndex + 1 }),
  ).toThrow('ambiguous-instance-source');
  expect(sources.get(100)).toEqual(original);
});

describe('same-submit cull-view decoding', () => {
  function view() {
    const bytes = new DataView(new ArrayBuffer(416));
    for (let i = 0; i < 24; i++) bytes.setFloat32(i * 4, i + 0.125, true);
    for (let i = 0; i < 16; i++) bytes.setFloat32(256 + i * 4, i + 0.25, true);
    bytes.setFloat32(320, 0.1, true);
    bytes.setFloat32(324, 200, true);
    bytes.setUint32(328, 0, true);
    bytes.setFloat32(332, 1, true);
    bytes.setUint32(336, 1, true);
    bytes.setUint32(340, 1, true);
    return bytes;
  }
  it('detaches submitted f32 planes and HZB camera from readback memory', () => {
    const bytes = view(),
      result = decodeGeometryView(bytes, 256, 336);
    expect(result).toMatchObject({
      scope: 'submitted-gpu-cull-view-constants',
      depthPyramid: 'unobserved',
      occlusionEnabled: true,
      occlusionHistoryValid: true,
      frustumPlanes: Array.from({ length: 24 }, (_, i) => i + 0.125),
      occlusionCamera: {
        viewProjection: Array.from({ length: 16 }, (_, i) => i + 0.25),
        near: Math.fround(0.1),
        far: 200,
        orthographic: false,
        footprintScale: 1,
      },
    });
    new Uint8Array(bytes.buffer).fill(0);
    expect(result.frustumPlanes[23]).toBe(23.125);
    expect(result.occlusionCamera?.viewProjection[15]).toBe(15.25);
    expect(structuredClone(result)).toEqual(result);
  });
  it('keeps disabled occlusion camera explicitly unobserved', () => {
    const bytes = view();
    bytes.setUint32(336, 0, true);
    bytes.setUint32(340, 0, true);
    bytes.setFloat32(256, NaN, true);
    expect(decodeGeometryView(bytes, 256, 336)).not.toHaveProperty('occlusionCamera');
  });
  it('rejects malformed offsets, states, frustum planes and enabled camera ranges', () => {
    for (const [offset, value, error] of [
      [0, NaN, 'view-constant-nonfinite'],
      [320, 0, 'view-constant-camera'],
      [324, 0, 'view-constant-camera'],
      [256, Infinity, 'view-constant-nonfinite'],
    ] as const) {
      const bytes = view();
      bytes.setFloat32(offset, value, true);
      expect(() => decodeGeometryView(bytes, 256, 336)).toThrow(error);
    }
    const bytes = view();
    bytes.setUint32(336, 0, true);
    expect(() => decodeGeometryView(bytes, 256, 336)).toThrow('view-constant-state');
    expect(() => decodeGeometryView(view(), -1, 336)).toThrow('view-constant-range');
    expect(() => decodeGeometryView(view(), 256, 415)).toThrow('view-constant-range');
  });
});

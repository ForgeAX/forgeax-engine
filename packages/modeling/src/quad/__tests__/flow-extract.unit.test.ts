import { describe, expect, it } from 'vitest';
import {
  bracket,
  brepSphere,
  brepTorus,
  chamferBox,
  flangedTee,
  lumpy,
} from '../../../examples/quad-field/models';
import { alignedPositionField } from '../../../examples/quad-flow/aligned-field';
import { extractFlowQuads } from '../flow-extract';
import { instantMeshesField } from '../instant-meshes';
import { solveIntegerOffsets } from '../integer-flow';
import type { TriMesh } from '../trimesh';

const fixtures: readonly [string, () => TriMesh][] = [
  ['sphere', brepSphere],
  ['torus', brepTorus],
  ['lumpy-sphere', lumpy],
  ['chamfer-box', chamferBox],
  ['bracket', bracket],
  ['flanged-tee', flangedTee],
];

function solve(mesh: TriMesh) {
  const flow = solveIntegerOffsets(alignedPositionField(mesh, 0.1, 0.037), {
    maxCapacity: 64,
  });
  if (!flow.ok) throw new Error(JSON.stringify(flow.error));
  return flow.value;
}

describe('integer-map quad extraction', () => {
  for (const [name, make] of fixtures) {
    if (name === 'torus') {
      it('torus fails closed because zero triangle charge does not imply a global vertex map', () => {
        const mesh = make();
        const result = extractFlowQuads(alignedPositionField(mesh, 0.1, 0.037), solve(mesh));
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.error.detail).toMatchObject({
            reason: 'integer-map-inconsistent',
          });
      });
      continue;
    }
    it(`${name} produces a reportable quad mesh`, () => {
      const mesh = make();
      const result = extractFlowQuads(alignedPositionField(mesh, 0.1, 0.037), solve(mesh));
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const { mesh: quads, report } = result.value;
      expect(quads.quads.length % 4).toBe(0);
      expect(quads.sourceFaces.length).toBe(report.quads * 2);
      expect(report.quads).toBeGreaterThan(0);
      expect(report.openEdges).toBeGreaterThanOrEqual(0);
      expect(report.invertedFoldedQuads).toBeGreaterThanOrEqual(0);
      expect(report.areaRatio).toBeGreaterThan(0);
    });
  }

  it('rejects an inconsistent integer map before producing quads', () => {
    const input = alignedPositionField(brepSphere(), 0.1, 0.037);
    const flow = solveIntegerOffsets(input, { flowDisabled: true });
    if (!flow.ok) throw new Error(JSON.stringify(flow.error));
    const result = extractFlowQuads(input, flow.value);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.detail).toMatchObject({
        reason: 'integer-map-inconsistent',
      });
  });

  it('rejects a broken edge offset with a structured consistency error', () => {
    const input = alignedPositionField(chamferBox(), 0.1, 0.037);
    const flow = solveIntegerOffsets(input, { maxCapacity: 64 });
    if (!flow.ok) throw new Error(JSON.stringify(flow.error));
    const brokenOffsets = flow.value.offsets.map((edge, index) =>
      index === 0 ? { ...edge, offset: [edge.offset[0] + 1, edge.offset[1]] as const } : edge,
    );
    const broken = {
      ...flow.value,
      offsets: brokenOffsets,
    };
    const result = extractFlowQuads(input, broken);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.detail).toMatchObject({
        reason: 'integer-map-inconsistent',
      });
  });

  it('fails closed on the unsupported real Instant Meshes torus flow', () => {
    const field = instantMeshesField(brepTorus(), { iterations: 2 });
    if (!field.ok) throw new Error(JSON.stringify(field.error));
    const result = solveIntegerOffsets(field.value.field, { maxCapacity: 64 });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.detail).toMatchObject({
        reason: 'integer-flow-capacity-limit',
      });
  });
});

import type { EngineWorkspaceAssetBinding } from '@forgeax/engine/app';
import type { WorkspaceAsset } from './contract.ts';

export function boundPreviewInspection(asset: WorkspaceAsset, binding: EngineWorkspaceAssetBinding) {
  const { kind: _kind, ...meta } = binding.meta ?? {};
  return { guid: asset.guid, asset, ...binding, meta };
}

export type PreviewFactRow = { key: string; value: string | number | boolean | null };
const record = (value: unknown): Readonly<Record<string, unknown>> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const count = (value: unknown): number | null => Array.isArray(value) ? value.length : null;
const scalar = (value: unknown): string => typeof value === 'object' ? JSON.stringify(value) : String(value);
export function previewFactValue(value: PreviewFactRow['value'], unavailable: string, yes: string, no: string): string {
  if (value === null) return unavailable;
  if (typeof value === 'boolean') return value ? yes : no;
  return String(value);
}

/** Project only facts the bound producer actually supplied; absence stays unavailable. */
export function meshPreviewFactRows(binding: EngineWorkspaceAssetBinding | undefined): PreviewFactRow[] {
  const facts = record(binding?.meta);
  const aabb = facts.aabb;
  const size = Array.isArray(aabb) && aabb.length === 6 && aabb.every(value => typeof value === 'number' && Number.isFinite(value))
    ? [0, 1, 2].map(axis => Number((aabb[axis + 3] - aabb[axis]).toPrecision(6))).join(' x ') : null;
  const collision = record(facts.collision);
  return [
    { key: 'triangles', value: number(facts.triangleCount) }, { key: 'vertices', value: number(facts.vertexCount) },
    { key: 'uvChannels', value: number(facts.uvChannelCount) }, { key: 'submeshes', value: count(facts.submeshes) },
    { key: 'materialSlots', value: count(facts.materialSlots) }, { key: 'dimensions', value: size },
    { key: 'declaredLods', value: number(facts.lodCount) }, { key: 'collisionData', value: typeof collision.present === 'boolean' ? collision.present : null },
    { key: 'collisionTriangles', value: number(collision.triangleCount) },
  ];
}

export function texturePreviewFactRows(binding: EngineWorkspaceAssetBinding | undefined): PreviewFactRow[] {
  const facts = record(binding?.meta);
  const shape = record(facts.shape);
  const extent = record(shape.extent);
  const mips = record(facts.mips);
  return [
    { key: 'dimensions', value: typeof extent.width === 'number' && typeof extent.height === 'number' ? `${extent.width} x ${extent.height}` : null },
    { key: 'dimension', value: text(shape.viewDimension) },
    ...(number(extent.layers) !== null ? [{ key: 'layers', value: number(extent.layers) }] : []),
    ...(number(extent.depth) !== null ? [{ key: 'depth', value: number(extent.depth) }] : []),
    { key: 'format', value: text(facts.format) }, { key: 'colorSpace', value: text(facts.colorSpace) },
    { key: 'mipPolicy', value: text(mips.kind) },
    ...(mips.kind === 'packed' ? [{ key: 'packedMips', value: number(mips.levelCount) }] : []),
    { key: 'dataBytes', value: number(facts.dataBytes) },
  ];
}

export function materialPreviewFacts(binding: EngineWorkspaceAssetBinding | undefined) {
  const facts = binding?.meta;
  if (!facts || facts.kind !== 'material') return undefined;
  return {
    passCount: number(facts.passCount), parameterCount: number(facts.parameterCount), textureParameterCount: number(facts.textureParameterCount),
    passes: Array.isArray(facts.passes) ? facts.passes.map(value => {
      const pass = record(value);
      return { name: text(pass.name) ?? '', program: text(pass.program), renderState: record(pass.renderState) };
    }) : [],
  };
}

export function materialPassStateRows(pass: NonNullable<ReturnType<typeof materialPreviewFacts>>['passes'][number]): PreviewFactRow[] {
  return [
    { key: 'program', value: pass.program },
    ...['blend', 'cullMode', 'depthCompare', 'depthWriteEnabled'].map(key => ({ key, value: pass.renderState[key] === undefined ? null : scalar(pass.renderState[key]) })),
  ];
}

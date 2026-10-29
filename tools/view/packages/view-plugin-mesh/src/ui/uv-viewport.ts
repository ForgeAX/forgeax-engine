import type { WorkspacePreviewDisplay } from '@forgeax/view-workspace-core/contract';

type Layout = NonNullable<NonNullable<WorkspacePreviewDisplay['uv']>['layout']>;
export type UvBounds = { minU: number; minV: number; maxU: number; maxV: number };
export type UvViewport = { centerU: number; centerV: number; zoom: number };
type Size = { width: number; height: number };
type Point = { x: number; y: number };
export type UvTransform = { scale: number; x: number; y: number };

export function uvBounds(layout: Pick<Layout, 'coordinates' | 'triangleIndices'>): UvBounds {
  const bounds = { minU: 0, minV: 0, maxU: 1, maxV: 1 };
  for (const index of layout.triangleIndices) {
    const u = layout.coordinates[index * 2];
    const v = layout.coordinates[index * 2 + 1];
    if (u === undefined || v === undefined || !Number.isFinite(u) || !Number.isFinite(v))
      throw new TypeError('UV bounds require finite referenced coordinates');
    bounds.minU = Math.min(bounds.minU, u);
    bounds.minV = Math.min(bounds.minV, v);
    bounds.maxU = Math.max(bounds.maxU, u);
    bounds.maxV = Math.max(bounds.maxV, v);
  }
  return bounds;
}

export function fitUvViewport(bounds: UvBounds): UvViewport {
  return { centerU: (bounds.minU + bounds.maxU) / 2, centerV: (bounds.minV + bounds.maxV) / 2, zoom: 1 };
}

export function uvTransform(bounds: UvBounds, size: Size, viewport: UvViewport | null): UvTransform {
  const view = viewport ?? fitUvViewport(bounds);
  const scale = Math.min(
    Math.max(1, size.width - 16) / (bounds.maxU - bounds.minU),
    Math.max(1, size.height - 16) / (bounds.maxV - bounds.minV),
  ) * view.zoom;
  return { scale, x: size.width / 2 - view.centerU * scale, y: size.height / 2 - view.centerV * scale };
}

export function uvAtPoint(transform: UvTransform, point: Point): { u: number; v: number } {
  return { u: (point.x - transform.x) / transform.scale, v: (point.y - transform.y) / transform.scale };
}

export function zoomUvViewport(bounds: UvBounds, size: Size, viewport: UvViewport | null, point: Point, delta: number): UvViewport {
  const view = viewport ?? fitUvViewport(bounds);
  const transform = uvTransform(bounds, size, view);
  const anchor = uvAtPoint(transform, point);
  const zoom = Math.max(1 / 32, Math.min(1024, view.zoom * Math.exp(-delta * 0.0015)));
  const scale = transform.scale * zoom / view.zoom;
  return { centerU: anchor.u - (point.x - size.width / 2) / scale, centerV: anchor.v - (point.y - size.height / 2) / scale, zoom };
}

export function panUvViewport(bounds: UvBounds, size: Size, viewport: UvViewport | null, dx: number, dy: number): UvViewport {
  const view = viewport ?? fitUvViewport(bounds);
  const { scale } = uvTransform(bounds, size, view);
  return { centerU: view.centerU - dx / scale, centerV: view.centerV - dy / scale, zoom: view.zoom };
}

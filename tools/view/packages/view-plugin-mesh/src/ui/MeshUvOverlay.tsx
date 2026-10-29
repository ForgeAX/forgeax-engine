import { useEffect, useMemo, useRef } from 'react';
import { Scan } from 'lucide-react';
import { IconButton, Tooltip } from '@forgeax/view-components';
import type { WorkspacePreviewDisplay } from '@forgeax/view-workspace-core/contract';
import { useTranslation } from '../i18n/useTranslation';
import { fitUvViewport, panUvViewport, uvBounds, uvTransform, zoomUvViewport, type UvViewport } from './uv-viewport';

type Layout = NonNullable<NonNullable<WorkspacePreviewDisplay['uv']>['layout']>;

export function MeshUvOverlay({ layout, viewport, onViewportChange }: {
  layout: Layout; viewport: UvViewport | null; onViewportChange: (viewport: UvViewport | null) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);
  const input = useRef({ viewport, onViewportChange });
  input.current = { viewport, onViewportChange };
  const redraw = useRef<() => void>(() => {});
  const bounds = useMemo(() => uvBounds(layout), [layout]);
  const view = viewport ?? fitUvViewport(bounds);

  useEffect(() => {
    const canvas = ref.current;
    const window = canvas?.ownerDocument.defaultView;
    if (!canvas || !window) return;
    // Keep paths in UV units so navigation and DPR only change the canvas transform.
    const white = new Path2D(), red = new Path2D();
    const { coordinates, triangleIndices } = layout;
    const outside = (index: number) => {
      const u = coordinates[index * 2]!;
      const v = coordinates[index * 2 + 1]!;
      return u < -1 / 1024 || u > 1 + 1 / 1024 || v < -1 / 1024 || v > 1 + 1 / 1024;
    };
    for (let triangle = 0; triangle < triangleIndices.length; triangle += 3) {
      for (let edge = 0; edge < 3; edge++) {
        const a = triangleIndices[triangle + edge]!;
        const b = triangleIndices[triangle + (edge + 1) % 3]!;
        const path = outside(a) || outside(b) ? red : white;
        path.moveTo(coordinates[a * 2]!, coordinates[a * 2 + 1]!);
        path.lineTo(coordinates[b * 2]!, coordinates[b * 2 + 1]!);
      }
    }
    let frame: number | undefined;
    let drag: { id: number; x: number; y: number; viewport: UvViewport | null } | undefined;
    const draw = () => {
      frame = undefined;
      const size = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(size.width * ratio));
      const height = Math.max(1, Math.round(size.height * ratio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return;
      const transform = uvTransform(bounds, size, input.current.viewport);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.setTransform(transform.scale * ratio, 0, 0, transform.scale * ratio, transform.x * ratio, transform.y * ratio);
      context.lineWidth = 1 / transform.scale;
      context.strokeStyle = '#9ca3af';
      context.strokeRect(0, 0, 1, 1);
      context.strokeStyle = '#ffffff';
      context.stroke(white);
      context.strokeStyle = '#f87171';
      context.stroke(red);
    };
    const schedule = () => { frame ??= window.requestAnimationFrame(draw); };
    redraw.current = schedule;
    const change = (next: UvViewport) => {
      input.current.viewport = next;
      input.current.onViewportChange(next);
      schedule();
    };
    const down = (event: PointerEvent) => {
      event.stopPropagation();
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, viewport: input.current.viewport };
      canvas.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      event.stopPropagation();
      if (!drag || event.pointerId !== drag.id) return;
      change(panUvViewport(bounds, canvas.getBoundingClientRect(), drag.viewport, event.clientX - drag.x, event.clientY - drag.y));
    };
    const up = (event: PointerEvent) => {
      event.stopPropagation();
      if (!drag || event.pointerId !== drag.id) return;
      drag = undefined;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const size = canvas.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
      const next = zoomUvViewport(bounds, size, input.current.viewport, { x: event.clientX - size.left, y: event.clientY - size.top }, delta);
      change(next);
      if (drag) drag = { ...drag, x: event.clientX, y: event.clientY, viewport: next };
    };
    const contextMenu = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('lostpointercapture', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('contextmenu', contextMenu);
    schedule();
    return () => {
      redraw.current = () => {};
      observer.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('lostpointercapture', up);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('contextmenu', contextMenu);
      if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [layout, bounds]);
  useEffect(() => { redraw.current(); }, [viewport]);

  return <figure className="fx-mesh-uv-overlay" data-testid="mesh-uv-overlay" data-uv-channel={layout.channel}
    data-uv-zoom={view.zoom} data-uv-center-u={view.centerU} data-uv-center-v={view.centerV}>
    <figcaption>
      <span>{t('mesh.uvChannel', { channel: layout.channel })} / LOD {layout.lod}</span>
      <Tooltip title={t('mesh.uvFrameAll')} placement="top" portaled>
        <IconButton label={t('mesh.uvFrameAll')} title="" icon={<Scan className="fx-icon" />} variant="secondary" size="compact" data-testid="mesh-uv-fit" onClick={() => onViewportChange(null)} />
      </Tooltip>
    </figcaption>
    <canvas ref={ref} tabIndex={0} aria-label={t('mesh.uvChannel', { channel: layout.channel })} />
  </figure>;
}

import { decodeToRgba8, type RhiDebugError } from '@forgeax/engine-rhi-debug';
import { Button, EmptyState, Field, Select, Spinner, TextInput } from '@forgeax/view-components';
import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { drawCallTextures, resolveTextureResource } from '../draw-call-resources';
import { useSelection } from '../selection-context';
import {
  capabilityAnchor,
  drawCallViewerAnchor,
  rtStatusAnchor,
  texelInfoAnchor,
  textureSliceAnchor,
  textureZoomAnchor,
} from '../selectors';
import {
  DEFAULT_TEXTURE_VIEW_STATE,
  type TextureViewState,
  textureAspectOptions,
  textureDescriptorFacts,
} from '../texture-view-state';
import {
  useInspectWork,
  useReadResource,
  useViewerCapability,
  useViewModel,
} from '../viewer-context';

type PixelStatus = 'no-rt' | 'no-webgpu' | 'loading' | 'ok' | 'error';
interface PixelPreview {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
}

interface TexturePan {
  readonly x: number;
  readonly y: number;
}

interface TextureDrag {
  readonly pointerId: number;
  readonly originX: number;
  readonly originY: number;
  readonly pan: TexturePan;
}

const ZERO_TEXTURE_PAN: TexturePan = { x: 0, y: 0 };
const MIN_TEXTURE_ZOOM = 1;
const MAX_TEXTURE_ZOOM = 65_536;
const WHEEL_ZOOM_RATE = 0.002;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function DrawCallViewer(_props?: { readonly className?: string }) {
  const model = useViewModel();
  const inspectWork = useInspectWork();
  const readResource = useReadResource();
  const capability = useViewerCapability();
  const { selectedWorkIndex, selectedResourceId, selectResource } = useSelection();
  const [status, setStatus] = useState<PixelStatus | null>(null);
  const [readbackError, setReadbackError] = useState<RhiDebugError | null>(null);
  const [pixels, setPixels] = useState<PixelPreview | null>(null);
  const [viewState, setViewState] = useState<TextureViewState>(DEFAULT_TEXTURE_VIEW_STATE);
  const [pan, setPan] = useState<TexturePan>(ZERO_TEXTURE_PAN);
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<TextureDrag | null>(null);
  const works = model?.works ?? [];
  const work = works.find((candidate) => candidate.workIndex === selectedWorkIndex);
  const textures = model === null ? [] : drawCallTextures(model, work);
  const selectedResourceTexture =
    model !== null && selectedResourceId !== null
      ? resolveTextureResource(model, selectedResourceId)
      : undefined;
  const explicitTexture = textures.find(
    (resource) => resource.resourceId === selectedResourceTexture?.resourceId,
  );
  const workTexture = textures[0];
  const selectedTexture = explicitTexture ?? workTexture;
  const textureFacts = textureDescriptorFacts(selectedTexture?.descriptor);
  const aspectOptions = textureAspectOptions(textureFacts.format);
  const effectiveAspect = aspectOptions.includes(viewState.aspect)
    ? viewState.aspect
    : aspectOptions[0];
  const selected = work !== undefined;
  const pixelStatus = !selected
    ? 'no-rt'
    : (status ?? (capability.kind === 'webgpu' ? 'loading' : 'no-webgpu'));

  useLayoutEffect(() => {
    if (pixels === null || canvasRef.current === null) return;
    const canvas = canvasRef.current;
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const context = canvas.getContext('2d');
    if (context === null) return;
    const image = context.createImageData(pixels.width, pixels.height);
    image.data.set(pixels.rgba);
    context.putImageData(image, 0, 0);
  }, [pixels]);

  const resetViewTransform = useCallback((zoom: TextureViewState['zoom']) => {
    setPan(ZERO_TEXTURE_PAN);
    setViewState((state) => ({ ...state, zoom }));
  }, []);

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (pixels === null) return;
      event.preventDefault();
      const stage = event.currentTarget.getBoundingClientRect();
      if (stage.width <= 0 || stage.height <= 0) return;

      const currentScale =
        viewState.zoom === 'fit'
          ? Math.min(stage.width / pixels.width, stage.height / pixels.height)
          : viewState.zoom / 100;
      const currentWidth = pixels.width * currentScale;
      const currentHeight = pixels.height * currentScale;
      const currentLeft = stage.left + (stage.width - currentWidth) / 2 + pan.x;
      const currentTop = stage.top + (stage.height - currentHeight) / 2 + pan.y;
      const anchorX = clamp((event.clientX - currentLeft) / currentWidth, 0, 1);
      const anchorY = clamp((event.clientY - currentTop) / currentHeight, 0, 1);
      const wheelDelta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.height : 1);
      const nextZoom = Math.round(
        clamp(
          currentScale * Math.exp(-wheelDelta * WHEEL_ZOOM_RATE) * 100,
          MIN_TEXTURE_ZOOM,
          MAX_TEXTURE_ZOOM,
        ),
      );
      const nextWidth = pixels.width * (nextZoom / 100);
      const nextHeight = pixels.height * (nextZoom / 100);
      const nextBaseLeft = stage.left + (stage.width - nextWidth) / 2;
      const nextBaseTop = stage.top + (stage.height - nextHeight) / 2;

      setPan({
        x: event.clientX - anchorX * nextWidth - nextBaseLeft,
        y: event.clientY - anchorY * nextHeight - nextBaseTop,
      });
      setViewState((state) => ({ ...state, zoom: nextZoom }));
    },
    [pan.x, pan.y, pixels, viewState.zoom],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || pixels === null) return;
      event.preventDefault();
      dragRef.current = {
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        pan,
      };
      setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [pan, pixels],
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPan({
      x: drag.pan.x + event.clientX - drag.originX,
      y: drag.pan.y + event.clientY - drag.originY,
    });
  }, []);

  const finishPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const inspectPixels = useCallback(
    async (signal?: AbortSignal) => {
      if (explicitTexture === undefined && (work === undefined || inspectWork === null)) return;
      setStatus(capability.kind === 'webgpu' ? 'loading' : 'no-webgpu');
      setReadbackError(null);
      const result =
        explicitTexture !== undefined && readResource !== null
          ? await readResource(
              explicitTexture.resourceId,
              {
                mipLevel: viewState.mipLevel,
                arrayLayer: viewState.arrayLayer,
                aspect: effectiveAspect,
              },
              signal,
            )
          : work === undefined || inspectWork === null
            ? null
            : await inspectWork(work.workIndex, ['pixels'], signal);
      if (signal?.aborted) return;
      const noWebGpu = capability.kind === 'no-webgpu';
      if (result === null) return;
      if (!result.ok) {
        setPixels(null);
        setReadbackError(result.error);
        setStatus(noWebGpu ? 'no-webgpu' : 'error');
        return;
      }
      setReadbackError(null);
      const attachment = 'attachment' in result.value ? result.value.attachment : result.value;
      if (
        attachment?.kind !== 'texture' ||
        attachment.format === undefined ||
        attachment.width === undefined ||
        attachment.height === undefined
      ) {
        setPixels(null);
        setReadbackError({
          code: 'readback-failed',
          expected: 'a texture attachment with format, width, height, and bytes',
          hint: 'inspect the selected resource descriptor and retry the readback operation',
          detail: {
            stage: 'readback',
            cause: 'canonical readback did not contain a decodable texture attachment',
          },
        });
        setStatus('error');
        return;
      }
      const rgba = decodeToRgba8(
        attachment.bytes,
        attachment.format,
        attachment.width,
        attachment.height,
        effectiveAspect,
      );
      if (rgba === null) {
        setPixels(null);
        setReadbackError({
          code: 'readback-failed',
          expected: 'a decodable color texture readback',
          hint: 'inspect the recorded texture format and retry the readback operation',
          detail: {
            stage: 'readback',
            cause: `texture format ${attachment.format} could not be decoded by the viewer`,
          },
        });
        setStatus('error');
        return;
      }
      setPixels({ width: attachment.width, height: attachment.height, rgba });
      setStatus('ok');
    },
    [
      capability.kind,
      explicitTexture,
      inspectWork,
      readResource,
      viewState.arrayLayer,
      effectiveAspect,
      viewState.mipLevel,
      work,
    ],
  );

  useEffect(() => {
    if (!selected) return;
    const request = new AbortController();
    void inspectPixels(request.signal);
    return () => request.abort();
  }, [inspectPixels, selected]);

  return (
    <section
      className="forgeax-panel flex flex-col overflow-auto"
      {...{ [drawCallViewerAnchor()]: selected ? 'selected' : 'default' }}
      {...{ [capabilityAnchor()]: capability.kind }}
    >
      {!selected ? (
        <EmptyState
          title="No work selected"
          description="Select a work item to inspect its attachment"
        />
      ) : (
        <div className="space-y-fx-12 p-fx-12 text-compact">
          <div className="flex items-center justify-between gap-fx-8">
            <span className="text-muted-foreground">
              {explicitTexture === undefined
                ? `Work ${work.workIndex} · draw attachment`
                : 'Selected resource'}
            </span>
            <span
              className={
                pixelStatus === 'ok'
                  ? 'text-caption text-success'
                  : pixelStatus === 'error'
                    ? 'text-caption text-danger'
                    : 'text-caption text-muted-foreground'
              }
              {...{ [rtStatusAnchor()]: pixelStatus }}
            >
              {pixelStatus === 'ok' ? 'pixels ready' : pixelStatus}
            </span>
          </div>
          {selectedTexture !== undefined && (
            <div className="space-y-fx-4">
              <div className="text-code text-foreground">
                {explicitTexture === undefined ? 'attachment' : 'resource'} ·{' '}
                {selectedTexture.resourceId}
              </div>
              <details>
                <summary className="text-caption text-muted-foreground">Texture descriptor</summary>
                <pre className="forgeax-code-block">
                  {JSON.stringify(selectedTexture.descriptor, null, 2)}
                </pre>
              </details>
            </div>
          )}
          <div className="forgeax-texture-controls border-y border-border py-fx-8">
            <div className="forgeax-texture-presets">
              <Button size="compact" onClick={() => resetViewTransform('fit')}>
                Fit
              </Button>
              <Button size="compact" onClick={() => resetViewTransform(100)}>
                1:1
              </Button>
            </div>
            <Field label="Zoom" htmlFor="rhi-texture-zoom">
              <TextInput
                id="rhi-texture-zoom"
                aria-label="Texture zoom"
                className="font-mono"
                size={6}
                value={viewState.zoom === 'fit' ? 'fit' : viewState.zoom}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  resetViewTransform(
                    Number.isFinite(value)
                      ? clamp(Math.round(value), MIN_TEXTURE_ZOOM, MAX_TEXTURE_ZOOM)
                      : 'fit',
                  );
                }}
                {...{
                  [textureZoomAnchor()]: viewState.zoom === 'fit' ? 'fit' : String(viewState.zoom),
                }}
              />
            </Field>
            <Field label="Mip" htmlFor="rhi-texture-mip">
              <Select
                id="rhi-texture-mip"
                className="font-mono"
                value={viewState.mipLevel}
                onChange={(event) =>
                  setViewState((state) => ({ ...state, mipLevel: Number(event.target.value) }))
                }
              >
                {Array.from({ length: textureFacts.mipLevelCount }, (_, value) => ({
                  key: `mip-${value}`,
                  value,
                })).map((option) => (
                  <option key={option.key} value={option.value}>
                    {option.value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Slice" htmlFor="rhi-texture-slice">
              <Select
                id="rhi-texture-slice"
                className="font-mono"
                value={viewState.arrayLayer}
                onChange={(event) =>
                  setViewState((state) => ({ ...state, arrayLayer: Number(event.target.value) }))
                }
                {...{ [textureSliceAnchor()]: String(viewState.arrayLayer) }}
              >
                {Array.from({ length: textureFacts.arrayLayerCount }, (_, value) => ({
                  key: `layer-${value}`,
                  value,
                })).map((option) => (
                  <option key={option.key} value={option.value}>
                    {option.value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Aspect" htmlFor="rhi-texture-aspect">
              <Select
                id="rhi-texture-aspect"
                value={effectiveAspect}
                onChange={(event) =>
                  setViewState((state) => ({
                    ...state,
                    aspect: event.target.value as TextureViewState['aspect'],
                  }))
                }
              >
                {aspectOptions.map((aspect) => (
                  <option key={aspect} value={aspect}>
                    {aspect}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div
            className="forgeax-status-card space-y-fx-8"
            {...{ [rtStatusAnchor()]: pixelStatus }}
          >
            <div
              className={`forgeax-texture-stage ${dragging ? 'is-dragging' : ''}`}
              data-forgeax-texture-stage=""
              onWheel={handleWheel}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishPointerDrag}
              onPointerCancel={finishPointerDrag}
              onLostPointerCapture={finishPointerDrag}
            >
              {pixels !== null && (
                <canvas
                  aria-label="RHI debug texture pixels"
                  data-forgeax-rt-canvas=""
                  ref={canvasRef}
                  className="image-pixelated"
                  style={
                    pixels === null || viewState.zoom === 'fit'
                      ? {
                          width: '100%',
                          height: '100%',
                          maxWidth: '100%',
                          maxHeight: '100%',
                          objectFit: 'contain',
                          transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                        }
                      : {
                          width: `${Math.max(1, pixels.width * (viewState.zoom / 100))}px`,
                          height: `${Math.max(1, pixels.height * (viewState.zoom / 100))}px`,
                          maxWidth: 'none',
                          maxHeight: 'none',
                          transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                        }
                  }
                />
              )}
              {pixelStatus !== 'ok' && (
                <div className="forgeax-texture-overlay" data-forgeax-texture-overlay={pixelStatus}>
                  {pixelStatus === 'no-webgpu' ? (
                    <div className="max-w-md space-y-fx-4">
                      <strong>Pixels unavailable: no WebGPU</strong>
                      <p className="text-muted-foreground">
                        Structure is available; open this tape in a WebGPU host to inspect pixels.
                      </p>
                      {readbackError !== null && (
                        <div
                          className="text-danger space-y-fx-4"
                          data-forgeax-readback-error={readbackError.code}
                        >
                          <strong>{readbackError.code}</strong>
                          <p data-forgeax-readback-detail>{JSON.stringify(readbackError.detail)}</p>
                          <p data-forgeax-readback-expected>{readbackError.expected}</p>
                          <p data-forgeax-readback-hint>{readbackError.hint}</p>
                        </div>
                      )}
                    </div>
                  ) : pixelStatus === 'no-rt' ? (
                    <div className="text-muted-foreground">
                      <p className="font-medium text-foreground">Pixel replay is ready</p>
                      <p className="mt-fx-4">
                        Inspect the selected draw attachment or choose a texture.
                      </p>
                    </div>
                  ) : pixelStatus === 'loading' ? (
                    <div data-forgeax-texture-loading-overlay="">
                      <Spinner label="Replaying selected work" />
                      <p className="mt-fx-12 font-medium text-foreground">
                        Replaying selected work
                      </p>
                      <p className="mt-fx-4 text-muted-foreground">
                        Keeping the viewport stable until fresh pixels arrive
                      </p>
                    </div>
                  ) : (
                    <div
                      className="text-danger max-w-md space-y-fx-4"
                      data-forgeax-readback-error={readbackError?.code ?? 'readback-failed'}
                    >
                      <strong>{readbackError?.code ?? 'readback-failed'}</strong>
                      <p data-forgeax-readback-detail>
                        {readbackError === null
                          ? 'Pixel inspection failed.'
                          : JSON.stringify(readbackError.detail)}
                      </p>
                      <p data-forgeax-readback-expected>
                        {readbackError?.expected ?? 'a successful canonical readback'}
                      </p>
                      <p data-forgeax-readback-hint>
                        {readbackError?.hint ?? 'retry the readback operation'}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <span className="text-caption text-muted-foreground" {...{ [texelInfoAnchor()]: '' }}>
            {pixels === null
              ? pixelStatus === 'loading'
                ? 'Automatic readback in progress'
                : 'Replay has not produced texels yet'
              : `${pixels.width}×${pixels.height} · first texel ${Array.from(pixels.rgba.slice(0, 4)).join(', ')}`}
          </span>
          <div className="space-y-fx-4">
            <div className="flex items-center justify-between">
              <div className="text-caption font-medium text-muted-foreground">Draw textures</div>
              <span className="text-caption text-muted-foreground">{textures.length}</span>
            </div>
            {textures.length === 0 ? (
              <p className="text-muted-foreground">
                No texture attachments or bindings for this work
              </p>
            ) : (
              <div className="grid max-h-44 grid-cols-2 gap-fx-4 overflow-auto pr-fx-4">
                {textures.map((resource, index) => (
                  <button
                    type="button"
                    key={resource.resourceId}
                    className={
                      explicitTexture?.resourceId === resource.resourceId
                        ? 'rounded border border-border bg-muted px-fx-8 py-fx-6 text-left text-code text-foreground'
                        : 'rounded border border-border px-fx-8 py-fx-6 text-left text-code text-muted-foreground hover:bg-muted hover:text-foreground'
                    }
                    onClick={() => selectResource(resource.resourceId)}
                    data-forgeax-texture-thumbnail={String(index)}
                  >
                    {resource.resourceId}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

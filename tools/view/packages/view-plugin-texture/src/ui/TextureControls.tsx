import type { TextureViewInfo, TextureViewOptions } from '@forgeax/view-workspace-core/contract';
import { usePanelVisible } from '@forgeax/view-components';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceTarget } from '@forgeax/view-workspace-core/contract';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from '../i18n/useTranslation';

type Props = { client: ViewWorkspaceClient; target: WorkspaceTarget; surface: RefObject<HTMLDivElement | null> };

export function TextureControls({ client, target, surface }: Props) {
  const visible = usePanelVisible();
  const { t } = useTranslation();
  const [info, setInfo] = useState<TextureViewInfo>();
  const [error, setError] = useState<string>();
  const changeRef = useRef<(patch: Partial<TextureViewOptions>) => void>(() => {});
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const args = { targetId: target.targetId, targetGeneration: target.generation };
    let current: TextureViewInfo | undefined;
    let accepted: TextureViewInfo | undefined;
    let queued: TextureViewOptions | undefined;
    let sending = false;
    let reading = false;
    let readPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (value: TextureViewInfo) => { current = value; setInfo(value); };
    const fail = (cause: unknown) => {
      if (controller.signal.aborted) return;
      queued = undefined;
      if (accepted) publish(accepted);
      setError(cause instanceof Error ? cause.message : String(cause));
    };
    const refresh = async () => {
      clearTimeout(timer);
      if (controller.signal.aborted || sending) return;
      if (reading) { readPending = true; return; }
      reading = true;
      try {
        do {
          readPending = false;
          const beforeRead = accepted;
          const result = await client.call<TextureViewInfo>('preview.texture.get', args, { signal: controller.signal });
          if (!controller.signal.aborted && !sending && accepted === beforeRead) { accepted = result; publish(result); }
        } while (readPending && !sending && !controller.signal.aborted);
      } catch (cause) { fail(cause); }
      finally {
        reading = false;
        if (!controller.signal.aborted) timer = setTimeout(refresh, 500);
      }
    };
    const send = async () => {
      if (sending) return;
      sending = true;
      try {
        while (queued && !controller.signal.aborted) {
          const options = queued;
          queued = undefined;
          const result = await client.call<TextureViewInfo>('preview.texture.set', { ...args, options }, { signal: controller.signal });
          if (controller.signal.aborted) return;
          accepted = result;
          if (!queued) publish(result);
        }
      } catch (cause) { fail(cause); }
      finally { sending = false; void refresh(); }
    };
    changeRef.current = patch => {
      if (!current || controller.signal.aborted) return;
      const options = { ...current.options, ...patch };
      publish({ ...current, options });
      queued = options;
      setError(undefined);
      void send();
    };
    setInfo(undefined);
    setError(undefined);
    void refresh();
    const unsubscribe = client.subscribe(state => {
      const currentTarget = [state.preview, ...(state.previews ?? [])].find(p => p?.target.targetId === target.targetId)?.target;
      if (!currentTarget || currentTarget.generation !== target.generation) controller.abort();
      else void refresh();
    });
    const element = surface.current;
    let drag: { id: number; x: number; y: number; options: TextureViewOptions } | undefined;
    const down = (event: PointerEvent) => {
      if (!current || event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, options: current.options };
      element?.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId || !current) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (drag.options.projection === 'environment') {
        changeRef.current({ rotation: [drag.options.rotation[0] - dx * 0.25, Math.max(-89, Math.min(89, drag.options.rotation[1] - dy * 0.25))] });
      } else {
        const dpr = element?.ownerDocument.defaultView?.devicePixelRatio ?? 1;
        changeRef.current({ pan: [drag.options.pan[0] + dx * dpr, drag.options.pan[1] + dy * dpr] });
      }
    };
    const up = () => { drag = undefined; };
    const wheel = (event: WheelEvent) => {
      if (!current || !element) return;
      event.preventDefault();
      const options = current.options;
      const dimensions = current.options.projection === 'cross' ? [current.width, current.width * 0.75] : current.options.projection === 'face' ? [current.height, current.height] : [Math.max(1, current.width >> options.mip), Math.max(1, current.height >> options.mip)];
      const dpr = element.ownerDocument.defaultView?.devicePixelRatio ?? 1;
      const fit = options.projection === 'environment' ? 1 : 0.9 * Math.min(element.clientWidth * dpr / dimensions[0]!, element.clientHeight * dpr / dimensions[1]!);
      const zoom = Math.max(0.03125, Math.min(1024, (options.zoom === 'fit' ? fit : options.zoom) * Math.exp(-event.deltaY * 0.0015)));
      changeRef.current({ zoom });
    };
    element?.addEventListener('pointerdown', down);
    element?.addEventListener('pointermove', move);
    element?.addEventListener('pointerup', up);
    element?.addEventListener('pointercancel', up);
    element?.addEventListener('lostpointercapture', up);
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => {
      controller.abort(); clearTimeout(timer); unsubscribe(); changeRef.current = () => {};
      if (drag && element?.hasPointerCapture(drag.id)) element.releasePointerCapture(drag.id);
      element?.removeEventListener('pointerdown', down);
      element?.removeEventListener('pointermove', move);
      element?.removeEventListener('pointerup', up);
      element?.removeEventListener('pointercancel', up);
      element?.removeEventListener('lostpointercapture', up);
      element?.removeEventListener('wheel', wheel);
    };
  }, [client, target.targetId, target.generation, surface, visible]);
  if (!info) return <div className="fx-texture-status" role="status">{error ?? t('texture.loading')}</div>;
  const options = info.options;
  const set = (patch: Partial<TextureViewOptions>) => changeRef.current(patch);
  const layers = info.dimension === '3d' ? Math.max(1, info.depth >> options.mip) : info.depth;
  return <>
    <div className="fx-texture-toolbar" role="toolbar" aria-label={t('texture.controls')}>
      <div className="fx-texture-channels" role="group" aria-label={t('texture.channels')}>
        {['R', 'G', 'B', 'A'].map((channel, index) => <button key={channel} type="button" aria-label={t('texture.channel', { channel })} aria-pressed={options.channels[index]} data-channel={channel} onClick={() => {
          const channels: [boolean, boolean, boolean, boolean] = [...options.channels]; channels[index] = !channels[index]; set({ channels });
        }}>{channel}</button>)}
      </div>
      <label>{t('texture.mip')}<select aria-label={t('texture.mip')} value={options.mip} disabled={info.mipCount === 1} onChange={e => set({ mip: Number(e.target.value), layer: 0 })}>
        {Array.from({ length: info.mipCount }, (_, mip) => <option key={mip} value={mip}>{mip} · {Math.max(1, info.width >> mip)} × {Math.max(1, info.height >> mip)}</option>)}
      </select></label>
      {info.dimension !== '2d' && <label>{t('texture.slice')}<input aria-label={t('texture.slice')} type="number" min={0} max={layers - 1} value={options.layer} onChange={e => { const layer = Number(e.target.value); if (Number.isInteger(layer) && layer >= 0 && layer < layers) set({ layer }); }} /></label>}
      {info.kind === 'equirect' && <label>{t('texture.projection')}<select aria-label={t('texture.projection')} value={options.projection} onChange={e => set({ projection: e.target.value as TextureViewOptions['projection'], pan: [0, 0], zoom: 'fit' })}>
        {(['environment', 'flat', 'cross', 'face'] as const).map(mode => <option key={mode} value={mode}>{t('texture.' + mode)}</option>)}
      </select></label>}
      {options.projection === 'face' && <label>{t('texture.face')}<select aria-label={t('texture.face')} value={options.face} onChange={e => set({ face: Number(e.target.value) })}>
        {['+X', '-X', '+Y', '-Y', '+Z', '-Z'].map((face, index) => <option key={face} value={index}>{face}</option>)}
      </select></label>}
      <button type="button" onClick={() => set({ zoom: 'fit', pan: [0, 0], rotation: [0, 0] })}>{t('texture.fit')}</button>
      <button type="button" onClick={() => set({ zoom: 1, pan: [0, 0] })}>100%</button>
      <label>{t('texture.filter')}<select aria-label={t('texture.filter')} value={options.filter} onChange={e => set({ filter: e.target.value as TextureViewOptions['filter'] })}>
        <option value="linear">{t('texture.linear')}</option><option value="nearest">{t('texture.nearest')}</option>
      </select></label>
      <label>{t('texture.exposure')}<input aria-label={t('texture.exposure')} type="number" min={-16} max={16} step={0.5} value={options.exposure} onChange={e => { const exposure = Number(e.target.value); if (Number.isFinite(exposure) && exposure >= -16 && exposure <= 16) set({ exposure }); }} /></label>
      <label>{t('texture.background')}<select aria-label={t('texture.background')} value={options.background} onChange={e => set({ background: e.target.value as TextureViewOptions['background'] })}>
        {(['checker', 'black', 'white'] as const).map(value => <option key={value} value={value}>{t('texture.' + value)}</option>)}
      </select></label>
      <button type="button" aria-pressed={options.desaturate} onClick={() => set({ desaturate: !options.desaturate })}>{t('texture.grayscale')}</button>
    </div>
    <div className="fx-texture-status" role="status">
      {error ? <span role="alert">{error}</span> : <><span>{info.width} × {info.height}{info.depth > 1 ? ` × ${info.depth}` : ''} · {info.format} · {info.colorSpace} · {info.mipCount} Mip · {(info.sourceBytes / 1024).toFixed(1)} KiB</span><span>{t(options.projection === 'environment' ? 'texture.rotateHint' : 'texture.panHint')}</span></>}
    </div>
  </>;
}

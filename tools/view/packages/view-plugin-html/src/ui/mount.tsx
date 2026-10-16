import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Monitor, Smartphone, Tablet, RectangleVertical, RectangleHorizontal, RefreshCw, Scan, Hand, MousePointer2, AlertTriangle } from 'lucide-react';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { VIEW_FILE_GET_SERVICE } from '@forgeax/view-workspace-core/contract';
import { CodeHighlight } from '@forgeax/view-components';
import '@forgeax/view-components/styles.css';
import { useTranslation } from '../i18n/useTranslation.ts';
import { HTML_DEVICE_PRESETS, presetSize, type HtmlUiStateStore, type HtmlUiViewState } from '../state.ts';
import { resolveProjectReference, resolveStandaloneHtml, type ProjectFile } from '../resolver.ts';
import './html.css';

type Props = { state: HtmlUiStateStore; client?: ViewWorkspaceClient; mountElement: HTMLElement };
type SourceTab = { path: string; kind: 'html' | 'style'; file?: ProjectFile };
const DEVICES = [['phone', Smartphone], ['tablet', Tablet], ['desktop', Monitor]] as const;
const ORIENTATIONS = [['portrait', RectangleVertical], ['landscape', RectangleHorizontal]] as const;
const INTERACTIONS = [['interact', MousePointer2], ['pan', Hand]] as const;

function previewExtent(view: HtmlUiViewState) {
  const phone = view.device === 'phone';
  const landscape = view.orientation === 'landscape';
  const tablet = view.device === 'tablet';
  return {
    width: view.width + (phone ? landscape ? 96 : 44 : tablet ? 36 : 20),
    height: view.height + (phone ? landscape ? 44 : 96 : tablet ? 36 : 108),
  };
}

function fitScale(width: number, height: number, extent: { width: number; height: number }) {
  return Math.min(1, Math.max(0.1, (width - 64) / extent.width), Math.max(0.1, (height - 64) / extent.height));
}

function useHtmlState(state: HtmlUiStateStore) { return useSyncExternalStore(state.subscribe, state.getSnapshot); }

function bridgeIframeInput(srcdoc: string) {
  // Screen coordinates stay stable while the iframe itself moves under the pointer.
  const bridge = `<script>(()=>{let active=false,lastX=0,lastY=0;const send=(type,e)=>parent.postMessage({type:'forgeax-html-pan',event:type,dx:e.screenX-lastX,dy:e.screenY-lastY},'*');document.addEventListener('pointerdown',e=>{if(e.button!==1&&e.button!==2)return;active=true;lastX=e.screenX;lastY=e.screenY;send('start',e);try{e.target.setPointerCapture(e.pointerId)}catch{}e.preventDefault()},true);document.addEventListener('pointermove',e=>{if(!active)return;send('move',e);lastX=e.screenX;lastY=e.screenY;e.preventDefault()},true);document.addEventListener('pointerup',e=>{if(!active)return;send('end',e);active=false},true);document.addEventListener('pointercancel',e=>{if(active){send('end',e);active=false}},true);document.addEventListener('wheel',e=>{e.preventDefault();parent.postMessage({type:'forgeax-html-pan',event:'wheel',x:e.clientX,y:e.clientY,deltaY:e.deltaY,deltaMode:e.deltaMode},'*')},{capture:true,passive:false});document.addEventListener('contextmenu',e=>e.preventDefault(),true)})()</script>`;
  return srcdoc.replace(/<\/body\s*>/i, `${bridge}</body>`);
}

function zoomPreview(state: HtmlUiStateStore, node: HTMLDivElement, clientX: number, clientY: number, deltaY: number, deltaMode: number) {
  const current = state.getSnapshot();
  const extent = previewExtent(current);
  const scale = current.zoom === 'fit' ? fitScale(node.clientWidth, node.clientHeight, extent) : current.zoom === 'actual' ? 1 : current.zoom;
  const delta = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? node.clientHeight : 1);
  const next = Math.min(4, Math.max(0.1, scale * Math.exp(-delta * 0.001)));
  if (next === scale) return;
  const bounds = node.getBoundingClientRect();
  const x = clientX - bounds.left - bounds.width / 2;
  const y = clientY - bounds.top - bounds.height / 2;
  state.zoomAt(next, { x: x - (x - current.pan.x) * next / scale, y: y - (y - current.pan.y) * next / scale });
}

function DimensionInput({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (Number.isInteger(parsed) && parsed >= 240 && parsed <= 4096) onCommit(parsed);
    else setDraft(String(value));
  };
  return <label><span>{label}</span><input type="number" min="240" max="4096" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}/></label>;
}

function ResolutionSelect({ view, state }: { view: HtmlUiViewState; state: HtmlUiStateStore }) {
  const { t } = useTranslation();
  const presets = HTML_DEVICE_PRESETS[view.device];
  const selected = presets.find((preset) => {
    const size = presetSize(preset, view.orientation);
    return size.width === view.width && size.height === view.height;
  });
  return <select className="html-resolution" aria-label={t('view.html.resolution')} title={selected ? `${selected.name} (${view.width} × ${view.height})` : t('view.html.custom')} value={selected?.id ?? 'custom'} onChange={(event) => state.selectPreset(event.target.value)}>
    {presets.map((preset) => {
      const size = presetSize(preset, view.orientation);
      return <option key={preset.id} value={preset.id}>{preset.name} ({size.width} × {size.height})</option>;
    })}
    <option value="custom" disabled>{t('view.html.custom')}</option>
  </select>;
}

function HtmlUiPreview({ state, client }: Props) {
  const { t } = useTranslation();
  const view = useHtmlState(state);
  const [document, setDocument] = useState<{ key: string; content: string; touchContent?: string } | null>(null);
  const [space, setSpace] = useState({ width: 0, height: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const temporaryPan = useRef(false);
  const [panning, setPanning] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setSpace({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomPreview(state, node, event.clientX, event.clientY, event.deltaY, event.deltaMode);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [state]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow) return;
      const message = event.data as { type?: unknown; event?: unknown; dx?: unknown; dy?: unknown; x?: unknown; y?: unknown; deltaY?: unknown; deltaMode?: unknown };
      if (message?.type !== 'forgeax-html-pan') return;
      if (message.event === 'wheel' && typeof message.x === 'number' && typeof message.y === 'number' && typeof message.deltaY === 'number' && typeof message.deltaMode === 'number' && [message.x, message.y, message.deltaY, message.deltaMode].every(Number.isFinite)) {
        const frame = iframe.current;
        const node = stage.current;
        if (!frame || !node) return;
        const bounds = frame.getBoundingClientRect();
        zoomPreview(state, node, bounds.left + message.x * bounds.width / frame.clientWidth, bounds.top + message.y * bounds.height / frame.clientHeight, message.deltaY, message.deltaMode);
        return;
      }
      if (message.event === 'start') { temporaryPan.current = true; setPanning(true); return; }
      if (message.event === 'end') { temporaryPan.current = false; setPanning(false); return; }
      if (message.event === 'move' && temporaryPan.current && typeof message.dx === 'number' && typeof message.dy === 'number') {
        if (message.dx || message.dy) state.panBy(message.dx, message.dy);
      }
    };
    const release = () => { temporaryPan.current = false; setPanning(false); };
    window.addEventListener('message', receive);
    window.addEventListener('blur', release);
    return () => { window.removeEventListener('message', receive); window.removeEventListener('blur', release); };
  }, [state]);
  useEffect(() => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    setPanning(false);
    if (stage.current?.hasPointerCapture(active.pointerId)) stage.current.releasePointerCapture(active.pointerId);
  }, [view.interaction, view.width, view.height, space.width, space.height]);
  useEffect(() => {
    const current = view.file;
    if (!current || !client?.transport?.request) { setDocument(null); return; }
    const key = `${current.projectId}:${current.path}:${view.revision}`;
    const controller = new AbortController();
    state.update({ status: 'loading', issues: [] });
    setDocument(null);
    const read = (path: string, options?: { signal?: AbortSignal }) => client.transport!.request!(VIEW_FILE_GET_SERVICE, { path }, options) as Promise<ProjectFile | null>;
    void client.getState({ signal: controller.signal }).then(async (snapshot) => {
      if (snapshot.project?.id !== current.projectId) throw new Error('HTML file belongs to a different project.');
      return read(current.path, { signal: controller.signal });
    }).then(async (file) => {
      if (file?.content == null) throw new Error(`HTML file is unavailable: ${current.path}`);
      const result = await resolveStandaloneHtml(file.content, file.path, read, controller.signal);
      if (controller.signal.aborted) return;
      setDocument({ key, content: result.srcdoc, touchContent: result.touchSrcdoc });
      state.update({ status: result.issues.length ? 'error' : 'ready', issues: result.issues, size: file.size, mtime: file.mtime });
    }).catch((error: unknown) => { if (!controller.signal.aborted) state.update({ status: 'error', issues: [error instanceof Error ? error.message : String(error)] }); });
    return () => controller.abort();
  }, [client, view.file?.path, view.file?.projectId, view.revision]);
  useEffect(() => {
    if (!client) return;
    return client.subscribe((snapshot) => {
      const current = state.getSnapshot().file;
      if (current && snapshot.project?.id !== current.projectId) state.update({ file: null, status: 'idle', issues: [] });
    });
  }, [client, state]);
  const phone = view.device === 'phone';
  const landscape = view.orientation === 'landscape';
  const documentKey = view.file ? `${view.file.projectId}:${view.file.path}:${view.revision}` : '';
  const srcdoc = document?.key === documentKey
    ? (view.device === 'phone' || view.device === 'tablet' ? document.touchContent ?? document.content : document.content)
    : '';
  const extent = previewExtent(view);
  const scale = view.zoom === 'fit' ? fitScale(space.width, space.height, extent) : view.zoom === 'actual' ? 1 : view.zoom;
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.button !== 0 && event.button !== 1 && event.button !== 2) || !event.isPrimary) return;
    if (event.button === 0 && view.interaction !== 'pan') return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    state.panBy(event.clientX - active.x, event.clientY - active.y);
    active.x = event.clientX;
    active.y = event.clientY;
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const effectiveSrcdoc = srcdoc ? bridgeIframeInput(srcdoc) : '';
  return <div className="html-preview" data-testid="html-ui-preview">
    <div className="html-preview-toolbar">
      <div className="html-preview-controls" role="toolbar" aria-label={t('view.html.viewport')}>
        {DEVICES.map(([name, Icon]) => <button type="button" key={name} title={t(`view.html.${name}`)} aria-label={t(`view.html.${name}`)} aria-pressed={view.device === name} onClick={() => state.selectDevice(name)}><Icon size={15}/></button>)}
        <ResolutionSelect view={view} state={state}/>
        <DimensionInput label={t('view.html.width')} value={view.width} onCommit={(value) => state.setDimension('width', value)}/>
        <span aria-hidden="true">×</span>
        <DimensionInput label={t('view.html.height')} value={view.height} onCommit={(value) => state.setDimension('height', value)}/>
        <span className="html-orientation" role="group" aria-label={t('view.html.orientation')}>{ORIENTATIONS.map(([name, Icon]) => <button type="button" key={name} title={t(`view.html.${name}`)} aria-label={t(`view.html.${name}`)} aria-pressed={view.orientation === name} onClick={() => state.selectOrientation(name)}><Icon size={15}/></button>)}</span>
        <span className="html-interaction" role="group" aria-label={t('view.html.mode')}>{INTERACTIONS.map(([name, Icon]) => <button type="button" key={name} title={t(`view.html.${name}`)} aria-label={t(`view.html.${name}`)} aria-pressed={view.interaction === name} onClick={() => state.update({ interaction: name })}><Icon size={15}/>{t(`view.html.${name}`)}</button>)}</span>
        <button type="button" title={t('view.html.fit')} aria-label={t('view.html.fit')} aria-pressed={view.zoom === 'fit'} onClick={() => state.setZoom('fit')}><Scan size={15}/></button>
        <button type="button" title="100%" aria-label="100%" aria-pressed={view.zoom === 'actual'} onClick={() => state.setZoom('actual')}>100%</button>
        <button type="button" title={t('view.html.refresh')} aria-label={t('view.html.refresh')} onClick={() => state.update({ revision: view.revision + 1 })}><RefreshCw size={15}/></button>
      </div>
    </div>
    <div className={`html-preview-stage${view.interaction === 'pan' ? ' is-pan-mode' : ''}${panning ? ' is-panning' : ''}`} ref={stage} onContextMenu={(event) => event.preventDefault()} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; setPanning(false); } }}>
      {view.file && srcdoc ? <div className="html-preview-scale" style={{ width: extent.width * scale, height: extent.height * scale, transform: `translate(-50%, -50%) translate(${view.pan.x}px, ${view.pan.y}px)` }}><div className={`html-preview-device is-${view.device}${phone && landscape ? ' is-landscape' : ''}`} style={{ width: extent.width, height: extent.height, transform: `scale(${scale})` }}>
        <div className="html-preview-frame" style={{ width: extent.width, height: extent.height - (view.device === 'desktop' ? 64 : 0) }}>
          {phone ? <div className="html-preview-notch" aria-hidden="true"/> : null}
          <iframe ref={iframe} key={`${view.file.path}:${view.revision}`} title={view.file.path} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={effectiveSrcdoc} style={{ width: view.width, height: view.height }} />
          {view.interaction === 'pan' ? <div className="html-preview-shield" style={{ width: view.width, height: view.height }} aria-hidden="true"/> : null}
          {phone ? <div className="html-preview-home" aria-hidden="true"/> : null}
          {view.device === 'tablet' ? <div className="html-preview-camera" aria-hidden="true"/> : null}
          {view.device === 'desktop' ? <div className="html-preview-monitor-led" aria-hidden="true"/> : null}
        </div>
        {view.device === 'desktop' ? <div className="html-preview-stand" aria-hidden="true"/> : null}
      </div></div> : <div className="html-preview-placeholder" role="status">{view.status === 'loading' ? t('view.html.loading') : view.file ? t('view.html.failed') : t('view.html.empty')}</div>}
    </div>
    <div className="html-preview-footer"><span>{Math.round(scale * 100)}%</span>{view.status === 'error' ? <span role="status"><AlertTriangle size={14}/>{t('view.html.issueCount', { count: view.issues.length })}</span> : null}</div>
  </div>;
}

function HtmlUiInspector({ state, client }: Props) {
  const { t } = useTranslation();
  const view = useHtmlState(state);
  const [files, setFiles] = useState<SourceTab[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [loadError, setLoadError] = useState('');
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  useEffect(() => {
    setLoadError('');
    if (!view.file || !client?.transport?.request) { setFiles([]); setSelectedPath(''); return; }
    const controller = new AbortController();
    const read = (path: string) => client.transport!.request!(VIEW_FILE_GET_SERVICE, { path }, { signal: controller.signal }) as Promise<ProjectFile | null>;
    void read(view.file.path).then(async (html) => {
      if (html?.content == null) throw new Error(`HTML file is unavailable: ${view.file!.path}`);
      const refs = [...new DOMParser().parseFromString(html.content, 'text/html').querySelectorAll('link[rel~="stylesheet"][href]')]
        .map((link) => resolveProjectReference(html.path, link.getAttribute('href') ?? ''))
        .filter((path): path is string => Boolean(path));
      if (/\.ui\.html$/i.test(html.path)) refs.push(html.path.replace(/\.ui\.html$/i, '.ui.css'));
      const paths = [...new Set(refs)];
      const styles = await Promise.all(paths.map(async (path) => ({ path, kind: 'style' as const, file: await read(path).catch(() => null) ?? undefined })));
      if (controller.signal.aborted) return;
      const next = [{ path: html.path, kind: 'html' as const, file: html }, ...styles.filter((item) => item.file?.content != null)];
      setFiles(next);
      setSelectedPath((current) => next.some((file) => file.path === current) ? current : html.path);
    }).catch((error: unknown) => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => controller.abort();
  }, [client, view.file?.path, view.file?.projectId, view.revision]);
  return <div className="html-inspector" data-testid="html-ui-inspector">
    <header className="html-source-header"><div className="html-source-file"><strong title={view.file?.path}>{view.file?.path?.split('/').at(-1) ?? t('view.html.file')}</strong><span>{view.size == null ? '' : `${(view.size / 1024).toFixed(1)} KB`} {view.mtime == null ? '' : new Date(view.mtime).toLocaleString()}</span></div></header>
    <nav className="html-source-tabs" aria-label={t('view.html.sourceFiles')}>{files.map((file) => <button key={file.path} className={selected?.path === file.path ? 'is-selected' : ''} title={file.path} aria-current={selected?.path === file.path ? 'page' : undefined} onClick={() => setSelectedPath(file.path)}>{file.path.split('/').at(-1)}</button>)}</nav>
    <div className="html-source-reader" aria-label={t('view.html.preview')}><CodeHighlight content={selected?.file?.content || (selected ? t('view.html.emptySource') : '')} lang={selected ? selected.kind === 'style' ? 'css' : 'html' : null} name={selected?.path} wrap={false}/></div>
    <footer className="html-source-footer">{loadError || view.issues.length ? <span className="html-status-error" role="alert">{loadError || t('view.html.issueCount', { count: view.issues.length })}</span> : null}{view.issues.length ? <ul className="html-issues">{view.issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul> : null}<span>{selected?.file ? new Date(selected.file.mtime).toLocaleString() : ''}</span></footer>
  </div>;
}

export async function mountHtmlUiPreviewPanel(props: Props) { const root = createRoot(props.mountElement); root.render(<HtmlUiPreview {...props}/>); return () => root.unmount(); }
export async function mountHtmlUiInspectorPanel(props: Props) { const root = createRoot(props.mountElement); root.render(<HtmlUiInspector {...props}/>); return () => root.unmount(); }

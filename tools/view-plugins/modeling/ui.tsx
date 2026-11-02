import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
 type CheckpointRow, checkpointRows, draftValues, type DraftHandle, type FacePick, highlightOverlays, mergePick, type ModelingHost,
 pickSize, pixelBox, pixelRay, type RenderedView, selectorReference, sliderValue, slidersOf, stabilityNotes, type SynthesisReport,
} from './model.ts';
import './style.css';

const VIEWS = ['iso', 'front', 'top', 'right', 'back', 'left', 'bottom'] as const;
const SIZE = 512;
function message(error: unknown): string {
 if (error && typeof error === 'object' && 'hint' in error) return `${String((error as { code?: unknown }).code ?? '')}: ${String(error.hint)}`;
 return error instanceof Error ? error.message : String(error);
}
function useDraft(handle: DraftHandle | undefined) {
 const empty = useMemo((): ReturnType<DraftHandle["getSnapshot"]> => ({ pending: false }), []);
 return useSyncExternalStore(l => handle?.subscribe(l) ?? (() => {}), () => handle?.getSnapshot() ?? empty, () => empty);
}

/** Checkpoints, sliders and pick -> selector; every value comes from an Engine operation. */
function ModelingPanel({ host }: { host: ModelingHost }) {
 const context = useSyncExternalStore(l => host.subscribe(l), () => host.context(), () => host.context());
 const [sources, setSources] = useState<string[]>([]);
 const [source, setSource] = useState('');
 // Rows belong to the Pack that listed them; the selection is a row key of that list, so
 // no request can pair one Pack's session or checkpoint with another Pack's source.
 const [listed, setListed] = useState<{ source: string; rows: CheckpointRow[] }>({ source: '', rows: [] });
 const [thumbs, setThumbs] = useState<Record<string, string>>({});
 const [selected, setSelected] = useState<string>();
 const [view, setView] = useState<(typeof VIEWS)[number]>('iso');
 const [rendered, setRendered] = useState<{ view: RenderedView; url: string; key: string }>();
 const [pick, setPick] = useState<FacePick>({});
 const [report, setReport] = useState<SynthesisReport>();
 const [recheck, setRecheck] = useState<{ key: string; expression: string; text: string }>();
 const [busy, setBusy] = useState('');
 const [error, setError] = useState('');
 const [preview, setPreview] = useState('');
 const drag = useRef<[number, number] | undefined>(undefined);
 const [box, setBox] = useState<[number, number, number, number]>();
 const handle = useMemo(() => (source ? host.draft(source) : undefined), [host, source, context.projectId]);
 const { draft } = useDraft(handle);
 const sliders = useMemo(() => slidersOf(draft?.fields ?? []), [draft?.fields]);
 const values = useMemo(() => draftValues(draft?.values, sliders), [draft?.values, sliders]);
 const valuesKey = JSON.stringify(values);
 const rows = listed.source === source ? listed.rows : [];
 const state = rows.find(r => r.key === selected);
 const where = (row: CheckpointRow | undefined) => ({ source, values, ...(row ? { session: row.session } : {}), ...(row?.checkpoint ? { checkpoint: row.checkpoint } : {}) });

 useEffect(() => { if (!context.projectId) return; void host.listSources().then(list => { setSources(list); setSource(s => s || list[0] || ''); }).catch(e => setError(message(e))); }, [host, context.projectId]);
 useEffect(() => { if (!handle) return; void handle.open().catch(e => setError(message(e))); return () => handle.dispose(); }, [handle]);
 useEffect(() => { setRendered(undefined); }, [source]);
 // Checkpoint list with previews, refreshed after parameter changes settle (0.5 s).
 useEffect(() => {
  if (!source) return;
  let live = true;
  const timer = setTimeout(async () => {
   try {
    setBusy('Inspecting'); setError('');
    const next = checkpointRows(await host.operations.inspect(source, values));
    if (!live) return;
    setListed({ source, rows: next });
    setSelected(current => (next.some(r => r.key === current) ? current : next[next.length - 1]?.key));
    // One state that cannot render must not hide the previews of the others.
    for (const row of next) {
     try {
      const out = await host.operations.render({ ...where(row), width: 160, height: 160 });
      const url = out.views[0] ? await host.readImage(out.views[0].image) : undefined;
      if (!live) return;
      if (url) setThumbs(t => ({ ...t, [`${source}|${row.key}:${valuesKey}`]: url }));
     } catch (e) { if (live) setError(`${row.name}: ${message(e)}`); }
    }
   } catch (e) { if (live) setError(message(e)); } finally { if (live) setBusy(''); }
  }, 500);
  return () => { live = false; clearTimeout(timer); };
 }, [host, source, valuesKey]);
 // The selected state in the chosen view, with the synthesized selection highlighted by the real renderer.
 useEffect(() => {
  if (!source || !state) return;
  let live = true;
  void (async () => {
   try {
    const selector = report?.expression;
    const out = await host.operations.render({ ...where(state), views: [view], width: SIZE, height: SIZE, ...(selector ? { selector } : {}) });
    const first = out.views[0];
    const url = first ? await host.readImage(first.image) : undefined;
    if (live && first && url) setRendered({ view: first, url, key: `${state.key}|${view}|${selector ?? ''}|${valuesKey}` });
   } catch (e) { if (live) setError(message(e)); }
  })();
  return () => { live = false; };
 }, [host, source, state?.key, view, valuesKey, report?.expression]);
 // A parameter change keeps the selector and re-evaluates it: does it still hit the region?
 useEffect(() => {
  if (!report || !state) { setRecheck(undefined); return; }
  let live = true;
  const key = valuesKey;
  const expression = report.expression;
  void host.operations.select({ ...where(state), selector: expression }).then(
   out => { if (live) setRecheck({ key, expression, text: `${out.selected.count} faces at the current parameters` }); },
   e => { if (live) setRecheck({ key, expression, text: message(e) }); });
  return () => { live = false; };
 }, [host, valuesKey, report?.expression]);

 // Picks settle for 0.6 s before one synthesis runs; only the latest request may publish.
 const synthesis = useRef<{ timer?: ReturnType<typeof setTimeout>; generation: number }>({ generation: 0 });
 const synthesize = (next: FacePick) => {
  clearTimeout(synthesis.current.timer);
  const generation = ++synthesis.current.generation;
  if (!state || pickSize(next) === 0) return;
  synthesis.current.timer = setTimeout(async () => {
   setBusy('Synthesizing'); setError('');
   try {
    const out = await host.operations.synthesize({ ...where(state), pick: next });
    if (generation === synthesis.current.generation) setReport(out);
   } catch (e) { if (generation === synthesis.current.generation) { setReport(undefined); setError(message(e)); } }
   finally { if (generation === synthesis.current.generation) setBusy(''); }
  }, 600);
 };
 const local = (event: { clientX: number; clientY: number; currentTarget: Element }): [number, number] => {
  const r = event.currentTarget.getBoundingClientRect();
  return [((event.clientX - r.left) / r.width) * SIZE, ((event.clientY - r.top) / r.height) * SIZE];
 };
 const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
  const start = drag.current; drag.current = undefined; setBox(undefined);
  if (!rendered || !start) return;
  const end = local(event);
  const moved = Math.hypot(end[0] - start[0], end[1] - start[1]) > 4;
  const added = moved ? pixelBox(rendered.view, start, end, !event.altKey) : pixelRay(rendered.view, end[0], end[1]);
  if (!added) { setError('Picking needs an orthographic view mapping from model.render.'); return; }
  const next = mergePick(pick, 'halfWidth' in added ? { boxes: [added] } : { rays: [added] }, !event.shiftKey);
  setPick(next); synthesize(next);
 };
 const highlight = async (clear = false) => {
  const target = context.previews.find(p => p.targetId === preview) ?? context.previews.find(p => rows.some(r => r.checkpoint === undefined && r.name === p.label)) ?? context.previews[0];
  if (!target) { setError('Open the Pack output in a preview to highlight it there.'); return; }
  try { await host.setOverlays(target, highlightOverlays(clear ? undefined : report)); } catch (e) { setError(message(e)); }
 };
 if (!context.projectId) return <p className="fx-model-note">Open a project to inspect its modeling Packs.</p>;
 const notes = report ? stabilityNotes(report) : [];
 return <div className="fx-model" data-modeling-status={busy || (error ? 'error' : 'idle')}>
  <header className="fx-model-bar">
   <label>Pack <select aria-label="Modeling Pack" value={source} onChange={e => { setSource(e.target.value); setPick({}); setReport(undefined); }}>
    {sources.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
   <label>View <select aria-label="View" value={view} onChange={e => setView(e.target.value as (typeof VIEWS)[number])}>{VIEWS.map(v => <option key={v}>{v}</option>)}</select></label>
   <span role="status">{busy}</span>
  </header>
  {error ? <p role="alert" className="fx-model-error">{error}</p> : null}
  <div className="fx-model-columns">
   <section aria-label="Checkpoints" className="fx-model-checkpoints">
    <h2>Checkpoints</h2>
    {rows.map(row => <button key={row.key} className={row.key === state?.key ? 'selected' : ''} data-checkpoint={row.checkpoint ?? 'final'} onClick={() => { setSelected(row.key); setPick({}); setReport(undefined); }}>
     {thumbs[`${source}|${row.key}:${valuesKey}`] ? <img alt="" src={thumbs[`${source}|${row.key}:${valuesKey}`]} /> : <span className="fx-model-thumb" />}
     <span>{row.name}</span><small>{row.faces} faces{row.opIndex === undefined ? '' : ` · op ${row.opIndex}`}</small>
    </button>)}
   </section>
   <section aria-label="Pick" className="fx-model-view">
    <div className="fx-model-image" onPointerDown={e => { drag.current = local(e); }} onPointerMove={e => { if (drag.current) { const p = local(e); setBox([drag.current[0], drag.current[1], p[0], p[1]]); } }} onPointerUp={onPointerUp}>
     {rendered ? <img alt={`${state?.name ?? ''} ${view}`} src={rendered.url} draggable={false} data-rendered={rendered.key} /> : <span className="fx-model-thumb" />}
     {box ? <span className="fx-model-box" style={{ left: `${Math.min(box[0], box[2]) / SIZE * 100}%`, top: `${Math.min(box[1], box[3]) / SIZE * 100}%`, width: `${Math.abs(box[2] - box[0]) / SIZE * 100}%`, height: `${Math.abs(box[3] - box[1]) / SIZE * 100}%` }} /> : null}
    </div>
    <p className="fx-model-note">Click a face, drag a box (Alt: include hidden faces), Shift adds. {pickSize(pick)} picks.</p>
   </section>
   <section aria-label="Selector" className="fx-model-side">
    <h2>Parameters</h2>
    {sliders.length === 0 ? <p className="fx-model-note">No ranged numeric parameters.</p> : sliders.map(s => {
     const value = typeof draft?.values[s.name] === 'number' ? draft.values[s.name] as number : s.min;
     return <label key={s.name} className="fx-model-slider">{s.name}
      <input type="range" aria-label={s.name} min={s.min} max={s.max} step={s.step} value={value} onChange={e => { handle?.edit(s.name, sliderValue(s, Number(e.target.value))); void handle?.flush().catch(err => setError(message(err))); }} />
      <output>{value}</output></label>;
    })}
    {draft?.unsaved ? <button onClick={() => void handle?.save().catch(e => setError(message(e)))}>Save parameters</button> : null}
    <h2>Selector</h2>
    {report ? <div className="fx-model-report" data-stability={report.stability}>
     <code data-selector>{report.expression}</code>
     <p>J = {report.jaccard} · {report.matched}/{report.picked} faces · <strong>{report.stability}</strong>{report.fallback ? ' (positional fallback)' : ''}</p>
     {notes.map(n => <p key={n} className="fx-model-note">{n}</p>)}
     {recheck?.expression === report.expression ? <p className="fx-model-note" data-recheck={recheck.key}>{recheck.text}</p> : null}
     <button onClick={() => void host.copy(selectorReference(report, { source, values }).text)}>Copy for AI</button>
     {context.previews.length > 1 ? <select aria-label="Preview" value={preview} onChange={e => setPreview(e.target.value)}>{context.previews.map(p => <option key={p.targetId} value={p.targetId}>{p.label}</option>)}</select> : null}
     <button disabled={context.previews.length === 0} onClick={() => void highlight()}>Highlight in preview</button>
     <button disabled={context.previews.length === 0} onClick={() => void highlight(true)}>Clear</button>
     {report.alternatives.length > 0 ? <details><summary>Alternatives</summary>{report.alternatives.map(a => <p key={a.expression}><code>{a.expression}</code> J = {a.jaccard}</p>)}</details> : null}
    </div> : <p className="fx-model-note">Pick faces to synthesize a selector.</p>}
   </section>
  </div>
 </div>;
}

export function mountModelingPanel({ mountElement, host }: { mountElement: HTMLElement; host: ModelingHost }) {
 const root = createRoot(mountElement); root.render(<ModelingPanel host={host} />); return () => root.unmount();
}

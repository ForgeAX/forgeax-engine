import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProfileModel } from '@forgeax/engine-profiler';
import './style.css';
type Result = { ok: true; value: ProfileModel } | { ok: false; error: { code: string; hint: string } };
function ProfilePanel({ readCapture }: { readCapture: (bytes: string) => Result }) {
 const [model, setModel] = useState<ProfileModel | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [name, setName] = useState('');
 const generation = useRef(0);
 const input = useRef<HTMLInputElement>(null);
 useEffect(() => () => { generation.current++; }, []);
 async function load(file?: File) {
  if (!file) return;
  const current = ++generation.current;
  try {
   const result = readCapture(await file.text());
   if (current !== generation.current) return;
   if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
   setModel(result.value); setName(file.name); setError(null);
  } catch (error) { if (current === generation.current) { setModel(null); setError(String(error)); } }
 }
 const max = model?.frames.reduce((max, frame) => Math.max(max, frame.durationMicros), 1) ?? 1;
 return <div className="fx-profile" data-profile-status={model ? 'loaded' : error ? 'error' : 'empty'}>
  <header><div><h1>CPU Profiler</h1><p>Inspect a ProfileCapture without opening a game project.</p></div>
  <button onClick={() => input.current?.click()}>Open capture</button><input ref={input} type="file" accept=".json" hidden onChange={event => void load(event.target.files?.[0])} /></header>
  {error && <p role="alert">{error}</p>}
  {!model && !error && <p className="fx-profile-empty">Select a real Engine capture. No runtime or GPU is started by this page.</p>}
  {model && <><h2>{name}</h2><div className="fx-profile-summary"><span>{model.summary.frameCount} frames</span><span>{model.summary.recordCount} records</span><span>P95 {model.summary.p95DurationMicros ?? '—'} µs</span><span>{model.completeness.status}</span></div>
  <svg viewBox="0 0 1000 180" role="img" aria-label="Frame CPU durations" data-profile-frames={model.frames.length}>
   {model.frames.map((frame, i) => <rect key={frame.frameId} x={i * 1000 / model.frames.length} y={170 - frame.durationMicros / max * 160} width={Math.max(1, 1000 / model.frames.length - 1)} height={frame.durationMicros / max * 160} fill="currentColor"><title>Frame {frame.frameId}: {frame.durationMicros} µs</title></rect>)}
  </svg><table><thead><tr><th>Source / phase</th><th>Samples</th><th>Skipped</th><th>P95 (µs)</th></tr></thead><tbody>{model.phases.map((phase,i) => <tr key={i}><td>{phase.source} / {phase.phase}</td><td>{phase.count}</td><td>{phase.skipCount}</td><td>{phase.p95DurationMicros ?? '—'}</td></tr>)}</tbody></table></>}
 </div>;
}
export function mountProfilerPanel({ mountElement, readCapture }: { mountElement: HTMLElement; readCapture: (bytes: string) => Result }) {
 const root = createRoot(mountElement); root.render(<ProfilePanel readCapture={readCapture} />); return () => root.unmount();
}

import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import './viewer.css';
// Reuse the real existing linked work/resource viewer, including replay and its no-GPU errors.
const TapeViewer = lazy(async () => ({ default: (await import('../../../apps/rhi-debug-viewer/src/App')).App }));
export function mountRhiDebugPanel({ mountElement }: { mountElement: HTMLElement }) {
 mountElement.classList.add('fx-rhi-tool');
 const root: Root = createRoot(mountElement);
 root.render(<Suspense fallback={<p role="status">Loading RHI Debug…</p>}><TapeViewer /></Suspense>);
 return () => root.unmount();
}

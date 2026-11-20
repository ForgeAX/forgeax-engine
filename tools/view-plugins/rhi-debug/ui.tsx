import { lazy, Suspense, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { getViewLocale, subscribeViewLocale, diagnosticText } from '../i18n.ts';
import './viewer.css';
// Reuse the real existing linked work/resource viewer, including replay and its no-GPU errors.
const TapeViewer = lazy(async () => ({ default: (await import('../../../apps/rhi-debug-viewer/src/App')).App }));
function RhiDebugPanel() {
 const locale = useSyncExternalStore(subscribeViewLocale, getViewLocale, getViewLocale);
 return <Suspense fallback={<p role="status">{diagnosticText('loadingRhi')}</p>}><TapeViewer locale={locale} /></Suspense>;
}
export function mountRhiDebugPanel({ mountElement }: { mountElement: HTMLElement }) {
 mountElement.classList.add('fx-rhi-tool');
 const root: Root = createRoot(mountElement);
 root.render(<RhiDebugPanel />);
 return () => root.unmount();
}

import type { Renderer } from '@forgeax/engine-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  buildLightingReferenceEvidence,
  buildRecoveryLightingReferenceEvidence,
  buildSpotCombinedLightingReferenceEvidence,
  createLightingSceneManifest,
  renderThreeCookieReference,
  renderThreeIesReference,
  renderThreeProbeReference,
  renderThreeRectReference,
  renderThreeRecoveryReference,
  renderThreeSpotCombinedReference,
  type LightingReferenceEvidence,
  type LightingSceneManifest,
  type ReferenceRenderReceipt,
} from './compare/lighting-reference';
import { createLightingEvidenceHooks, type LightingEvidenceHooks } from './compare/evidence-hooks';
import { createExtendedLightingRuntime, type ExtendedLightingRuntimeMode } from './compare/extended-lighting-runtime';

const MODES = ['rect', 'ies', 'cookie', 'probe'] as const;
type DemoMode = (typeof MODES)[number];

const COPY: Record<DemoMode, { title: string; subtitle: string }> = {
  rect: { title: 'RECT AREA LIGHT', subtitle: 'finite rectangle · LTC diffuse + GGX response' },
  ies: { title: 'IES PROFILE', subtitle: 'cooked LM-63 Type C profile · azimuthal lobes' },
  cookie: { title: 'LIGHT COOKIE', subtitle: 'non-square RGBA source · linear 256×256 slice · spot cone composition' },
  probe: { title: 'LOCAL DIFFUSE PROBES', subtitle: 'continuous finite-support blend · residual Sky irradiance' },
};

declare global {
  var __forgeaxLightingDemo:
    | {
        ready: boolean;
        mode: DemoMode;
        runtimeMode: string;
        compare: boolean;
        frameCount: number;
        productHead: string;
        sceneManifest?: LightingSceneManifest;
        evidenceHooks: LightingEvidenceHooks;
        reference?: {
          readonly evidence: LightingReferenceEvidence;
          readonly render: ReferenceRenderReceipt;
        };
        inspection?: ReturnType<Renderer['inspect']>;
        error?: string;
      }
    | undefined;
}

const canvas = document.querySelector<HTMLCanvasElement>('#demo');
const status = document.querySelector<HTMLDivElement>('#status');
const title = document.querySelector<HTMLHeadingElement>('#title');
const subtitle = document.querySelector<HTMLParagraphElement>('#subtitle');
const nav = document.querySelector<HTMLElement>('#nav');
const threeReferenceCanvas = document.querySelector<HTMLCanvasElement>('#three-reference');
const threePanelLabel = document.querySelector<HTMLSpanElement>('#three-panel-label');
if (!canvas || !status || !title || !subtitle || !nav || !threeReferenceCanvas || !threePanelLabel) {
  throw new Error('lighting demo DOM is incomplete');
}
const demoCanvas = canvas;

const searchParams = new URLSearchParams(location.search);
const requested = searchParams.get('mode');
const mode: DemoMode = MODES.includes(requested as DemoMode) ? (requested as DemoMode) : 'rect';
const compare = searchParams.get('compare') === 'three';
// Kept as an explicit control experiment: it removes only the IES/cookie map
// from both sides so a residual can be assigned to the shared punctual/PBR
// path. It is not part of the showcase routes.
const diagnosticPlainSpot = searchParams.get('diagnostic') === 'spot-plain';
const diagnosticCombined = searchParams.get('diagnostic') === 'spot-combined';
const diagnosticRecovery = searchParams.get('diagnostic') === 'recovery-baseline';
const runtimeMode: ExtendedLightingRuntimeMode = diagnosticCombined ? 'spot-combined' : diagnosticRecovery ? 'recovery' : mode;
const referenceMode = diagnosticCombined || diagnosticRecovery ? 'ies' : mode;
document.body.dataset.compare = String(compare);
if (compare) {
  demoCanvas.width = 760;
  demoCanvas.height = 540;
  title.textContent = diagnosticCombined
    ? 'IES + COOKIE + SHADOW — THREE.JS r184 A/B'
    : diagnosticRecovery
      ? 'RECOVERY BASELINE — THREE.JS r184 A/B'
      : `${COPY[mode].title} — THREE.JS r184 A/B`;
  subtitle.textContent = 'shared camera · geometry · materials · exposure · independent reference';
  threePanelLabel.textContent = diagnosticCombined
    ? 'THREE.JS r184 · WEBGPU · native IES + SpotLight.map + shadow'
    : diagnosticRecovery
      ? 'THREE.JS r184 · WEBGPU · Rect + IES/Cookie + Sky baseline (lifecycle is ForgeaX-owned)'
      : mode === 'ies'
    ? diagnosticPlainSpot
      ? 'THREE.JS r184 · WEBGPU · plain SpotLight baseline'
      : 'THREE.JS r184 · WEBGPU · IES native + product-equivalent cone fold + Type-C analytic'
    : mode === 'cookie'
      ? diagnosticPlainSpot
        ? 'THREE.JS r184 · WEBGL2 · plain SpotLight baseline'
        : 'THREE.JS r184 · WEBGL2 · SpotLight.map + alpha-folded product semantics + aspect'
      : mode === 'probe'
        ? 'THREE.JS r184 · WEBGL2 · LightProbe SH9 + analytic local volume (not native local volume)'
        : 'THREE.JS r184 · WEBGL2 · native RectAreaLight';
} else {
  title.textContent = COPY[mode].title;
  subtitle.textContent = COPY[mode].subtitle;
}
for (const candidate of MODES) {
  const link = document.createElement('a');
  link.href = `?mode=${candidate}`;
  link.textContent = candidate.toUpperCase();
  if (candidate === mode) link.setAttribute('aria-current', 'page');
  nav.append(link);
  const compareLink = document.createElement('a');
  compareLink.href = `?mode=${candidate}&compare=three`;
  compareLink.textContent = `${candidate.toUpperCase()} A/B`;
  if (candidate === mode && compare) compareLink.setAttribute('aria-current', 'page');
  nav.append(compareLink);
}

globalThis.__forgeaxLightingDemo = { ready: false, mode, runtimeMode, compare, frameCount: 0, productHead: __FORGEAX_PRODUCT_HEAD__, evidenceHooks: createLightingEvidenceHooks(mode, __FORGEAX_PRODUCT_HEAD__) };

try {
  const sceneData = await createLightingSceneManifest(referenceMode, __FORGEAX_PRODUCT_HEAD__, compare);
  const evidence = diagnosticCombined
    ? buildSpotCombinedLightingReferenceEvidence(compare)
    : diagnosticRecovery
      ? buildRecoveryLightingReferenceEvidence(compare)
      : buildLightingReferenceEvidence(referenceMode, compare);
  let reference: ReferenceRenderReceipt | undefined;
  if (compare) {
    reference = diagnosticCombined
      ? await renderThreeSpotCombinedReference(threeReferenceCanvas, sceneData.ies, sceneData.cookie, sceneData.manifest)
      : diagnosticRecovery
        ? await renderThreeRecoveryReference(threeReferenceCanvas, sceneData.ies, sceneData.cookie, sceneData.manifest)
        : mode === 'ies'
      ? await renderThreeIesReference(threeReferenceCanvas, sceneData.ies, sceneData.manifest, diagnosticPlainSpot)
      : mode === 'cookie'
        ? renderThreeCookieReference(threeReferenceCanvas, sceneData.cookie, sceneData.manifest, diagnosticPlainSpot)
        : mode === 'probe'
          ? renderThreeProbeReference(threeReferenceCanvas, evidence.probe?.objects ?? (() => { throw new Error('probe reference evidence is incomplete'); })(), sceneData.manifest)
          : renderThreeRectReference(threeReferenceCanvas, sceneData.manifest);
  }
  const runtime = await createExtendedLightingRuntime({
    canvas: demoCanvas,
    mode: runtimeMode,
    assets: { ies: sceneData.ies, cookie: sceneData.cookie },
    manifest: sceneData.manifest,
    bundler: forgeaxBundlerAdapter() as never,
    comparisonMode: compare,
    plainSpot: diagnosticPlainSpot,
  });
  const frameCount = runtime.frameCount;
  const inspection = runtime.inspect();
  globalThis.__forgeaxLightingDemo = {
    ready: true,
    mode,
    runtimeMode,
    compare,
    frameCount,
    productHead: __FORGEAX_PRODUCT_HEAD__,
    sceneManifest: {
      ...sceneData.manifest,
      ...(reference === undefined ? {} : { referenceKind: reference.referenceKind }),
      three: { ...sceneData.manifest.three, backend: reference?.backend ?? 'none' },
      adapterProvenance: evidence.adapters,
    },
    evidenceHooks: createLightingEvidenceHooks(mode, __FORGEAX_PRODUCT_HEAD__),
    ...(reference ? { reference: { evidence, render: reference } } : {}),
    inspection,
  };
  status.textContent = compare
    ? `ForgeaX ${inspection.capabilities.backendKind} · Three.js r184 ${reference?.backend ?? 'reference'} · ${frameCount} ForgeaX frames`
    : `WebGPU · ${inspection.capabilities.backendKind} · ${frameCount} submitted frames`;
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  globalThis.__forgeaxLightingDemo = {
    ready: false,
    mode,
    runtimeMode,
    compare,
    frameCount: 0,
    productHead: __FORGEAX_PRODUCT_HEAD__,
    evidenceHooks: createLightingEvidenceHooks(mode, __FORGEAX_PRODUCT_HEAD__),
    error: message,
  };
  status.dataset.error = 'true';
  status.textContent = message;
  console.error(error);
}

import { createApp } from '../../packages/app/dist/browser.mjs';
import { FORGEAX_FRAME_COMPLETED_EVENT } from '../../packages/app/dist/index.mjs';
import {
  cells,
  gridWidth,
  roadX,
  streamingRadius,
  worldEdge,
  worldMeters,
} from './fixtures/level-streaming-landscape.mjs';

const canvas = document.querySelector('#view');
const map = document.querySelector('#map');
const route = document.querySelector('#route');
const counts = document.querySelector('#counts');
const speed = document.querySelector('#speed');
const cruise = document.querySelector('#cruise');
const error = document.querySelector('#error');
const context = map.getContext('2d');
const channel = new MessageChannel();
let app;
let firstFrame = false;
let latest;
let failure;
let cruiseRequested = false;

function drawMap(state) {
  const width = map.width;
  context.clearRect(0, 0, width, map.height);
  const step = width / gridWidth;
  const toPixel = (metres) => ((metres + worldEdge) * width) / worldMeters;
  const live = new Map(state?.live.map((cell) => [cell.id, cell.phase]));
  const retired = new Set(state?.retired);
  for (const cell of cells) {
    const phase = live.get(cell.id);
    context.fillStyle =
      phase === 'active'
        ? '#729956'
        : phase
          ? '#b89448'
          : retired.has(cell.id)
            ? '#4b7480'
            : '#304b3e';
    context.fillRect(toPixel(cell.x) + 1, toPixel(cell.z) + 1, step - 2, step - 2);
  }
  context.strokeStyle = '#d2c9a0';
  context.lineWidth = 1.3;
  context.beginPath();
  for (let z = -worldEdge; z <= worldEdge; z += 32) {
    const x = toPixel(roadX(z));
    if (z === -worldEdge) context.moveTo(x, 0);
    else context.lineTo(x, toPixel(z));
  }
  context.stroke();
  if (!state) return;
  context.strokeStyle = '#d5e6bd';
  context.lineWidth = 1;
  for (const radius of [streamingRadius.visible, streamingRadius.prepare]) {
    context.setLineDash(radius === streamingRadius.prepare ? [2, 2] : []);
    context.beginPath();
    context.arc(toPixel(state.x), toPixel(state.z), (radius * width) / worldMeters, 0, 2 * Math.PI);
    context.stroke();
  }
  context.setLineDash([]);
  context.fillStyle = '#fff2cc';
  context.beginPath();
  context.arc(toPixel(state.x), toPixel(state.z), 3.5, 0, 2 * Math.PI);
  context.fill();
}

function show(state) {
  const active = state.live.filter((cell) => cell.phase === 'active').length;
  const current = state.live.find((cell) => cell.id === state.current);
  const message =
    current?.phase !== 'active'
      ? 'Preparing your area…'
      : state.paused
        ? 'Preparing the next area…'
        : 'Explore the basin';
  const label = `${message} · ${(state.distance / 1000).toFixed(2)} km driven`;
  if (route.textContent !== label) route.textContent = label;
  route.dataset.cell = String(state.current);
  counts.textContent = `${active} live · ${state.retired.length} retired`;
  if (state.speedKph !== undefined) speed.textContent = `${Math.round(state.speedKph)} km/h`;
  cruise.disabled = false;
  cruiseRequested = state.cruise;
  cruise.setAttribute('aria-pressed', String(state.cruise));
  drawMap(state);
}

function fail(cause) {
  failure = cause;
  route.textContent = 'Pine Basin stopped.';
  error.hidden = false;
  error.textContent = [cause.message, cause.reason].filter(Boolean).join('\n');
}

function appFailure(cause) {
  const detail = cause.detail?.cause ?? cause.cause;
  const reason = detail?.message ?? (typeof detail === 'object' ? JSON.stringify(detail) : detail);
  fail({ message: cause.stack ?? String(cause), reason });
}

channel.port1.onmessage = ({ data }) => {
  if (data.kind === 'failed') fail(data);
  if (data.kind === 'position') {
    latest = data;
    if (firstFrame && !failure) show(data);
  }
  document.dispatchEvent(new CustomEvent('pine-basin-streaming', { detail: data }));
};
drawMap();
cruise.addEventListener('click', () => {
  cruiseRequested = !cruiseRequested;
  channel.port1.postMessage({ kind: 'cruise', enabled: cruiseRequested });
  canvas.focus({ preventScroll: true });
});
canvas.addEventListener('pointerdown', () => canvas.focus());
document.addEventListener('keydown', (event) => {
  if (document.activeElement === canvas && event.code.startsWith('Arrow')) event.preventDefault();
});
window.addEventListener(
  'pagehide',
  () => {
    channel.port1.close();
    void app?.dispose();
  },
  { once: true },
);

try {
  const response = await fetch('/__level/play/fixture');
  if (!response.ok) throw Error((await response.json()).error);
  const { manifest, catalogUrl, expectedScope } = await response.json();
  app = (
    await createApp(
      canvas,
      {
        execution: {
          workers: { engine: true, render: true, kernels: false },
          diagnostics: { geometryLane: 'direct' },
          bootstrap: new URL('./level-streaming-world-bootstrap.mjs', import.meta.url),
          bootstrapPort: channel.port2,
          bootstrapData: { manifest },
          assetCatalog: { url: catalogUrl, expectedScope },
          startupTimeoutMs: 90_000,
        },
      },
      { shaderManifestUrl: new URL('/__level/play/shaders', location.href).href },
    )
  ).unwrap();
  app.onError(appFailure);
  const firstReadyFrame = ({ detail }) => {
    if (detail.presentation !== 'ready') return;
    canvas.removeEventListener(FORGEAX_FRAME_COMPLETED_EVENT, firstReadyFrame);
    firstFrame = true;
    channel.port1.postMessage({ kind: 'start-streaming' });
    if (latest && !failure) show(latest);
  };
  canvas.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, firstReadyFrame);
  app.execution.setFrameRateLimit(60);
  app.start().unwrap();
  canvas.focus({ preventScroll: true });
} catch (cause) {
  appFailure(cause);
}

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// Pinned official UI release; operators may supply their own hosted Perfetto build.
export const PERFETTO_UI = 'https://ui.perfetto.dev/v59.1-79997ada9/';

export function perfettoUiUrl(value = PERFETTO_UI) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error('Perfetto UI must be an http(s) base URL without credentials, query or fragment');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export function perfettoHtml(metadata, trace, options = {}) {
  const bytes = Buffer.from(JSON.stringify(trace));
  metadata = {
    ...metadata,
    ui: perfettoUiUrl(options.ui),
    traceSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${metadata.title} · Perfetto</title><style>body{margin:0;background:#101a28;color:#e2ebf8;font:14px/1.45 system-ui}header{padding:12px 20px;border-bottom:1px solid #445c76}h1{font-size:20px;margin:0 0 8px}button,input,select,a{font:inherit;color:inherit;background:#20344d;border:1px solid #536c88;border-radius:4px;padding:5px 9px;margin:3px}button,a{cursor:pointer}a{display:inline-block;text-decoration:none}input[type=number]{width:115px}#viewer{width:100%;height:calc(100vh - 205px);min-height:550px;border:0;background:white}#error{color:#ffb5a2}#status{color:#9edbcf}small{color:#acc0d8}details pre{white-space:pre-wrap;max-height:260px;overflow:auto}#help{margin:7px 0}</style><header><h1>${metadata.title} · Perfetto</h1><div><label>Open trace JSON <input id="load" type="file" accept=".json,.pftrace,.gz"></label><label>Interval <select id="frame"><option value="">Choose interval</option></select></label><label>From ms <input id="from" type="number" step="any"></label><label>To ms <input id="to" type="number" step="any"></label><button id="range">Show range</button><button id="full">Full capture</button><button id="retry">Reload viewer</button></div><div id="help">${metadata.links.map(([href, label]) => `<a href="${href}" target="_blank">${label}</a>`).join('')}<small>${metadata.hint} Perfetto: W/S zoom · A/D pan · click a slice for arguments · drag to select a range.</small></div><div id="status" role="status"></div><div id="error" role="alert"></div><details><summary>Capture identity, coverage and interpretation</summary><pre id="facts"></pre></details></header><iframe id="viewer" title="Perfetto ${metadata.title}" allow="clipboard-write"></iframe><script id="trace-data" type="application/octet-stream">${gzipSync(bytes).toString('base64')}</script><script type="module">${mountPerfetto.toString()}\nmountPerfetto(${JSON.stringify(metadata).replaceAll('<', '\\u003c')}, ${options.converterSource ?? 'null'}, ${options.normalizeSource ?? 'null'});</script></html>`;
}

/** Use the official embedding protocol; Perfetto owns timeline rendering and interaction. */
export function mountPerfetto(initial, convertTimeline, normalizeInput) {
  const el = (id) => document.getElementById(id);
  let frame = el('viewer');
  let meta = initial,
    bytes,
    ready = false,
    timer,
    deadline,
    generation = 0;
  const origin = new URL(initial.ui).origin;
  const fail = (error) => {
    el('error').textContent = error.message;
  };
  const guard =
    (fn) =>
    async (...args) => {
      try {
        el('error').textContent = '';
        await fn(...args);
      } catch (error) {
        fail(error);
      }
    };
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  const range = () => {
    const from = Number(el('from').value),
      to = Number(el('to').value);
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < meta.startMs ||
      to > meta.endMs ||
      to <= from
    )
      throw Error('Choose an increasing range within this capture (milliseconds)');
    if (!ready) throw Error('Wait for the Perfetto viewer handshake');
    frame.contentWindow.postMessage(
      { perfetto: { timeStart: from / 1000, timeEnd: to / 1000, viewPercentage: 1 } },
      origin,
    );
  };
  const fill = () => {
    for (const id of ['from', 'to', 'range', 'full', 'frame'])
      el(id).disabled = meta.endMs <= meta.startMs;
    el('frame').closest('label').hidden = meta.frames.length === 0;
    el('from').value = meta.fromMs;
    el('to').value = meta.toMs;
    el('facts').textContent = JSON.stringify(meta, null, 2);
    el('frame').replaceChildren(new Option('Choose interval', ''));
    for (const [index, item] of meta.frames.entries())
      el('frame').append(
        new Option(
          '#' + item.id + ' · ' + (item.endMs - item.startMs).toFixed(3) + ' ms',
          String(index),
        ),
      );
  };
  const open = () => {
    stop();
    ready = false;
    generation++;
    el('status').textContent = 'Loading Perfetto UI…';
    const hash = new URLSearchParams({
      mode: 'embedded',
      startupCommands: JSON.stringify([{ id: 'dev.perfetto.ExpandAllGroups' }]),
      visStart: String(Math.round(meta.fromMs * 1e6)),
      visEnd: String(Math.round(meta.toMs * 1e6)),
    });
    const replacement = frame.cloneNode(false);
    frame.replaceWith(replacement);
    frame = replacement;
    frame.src = initial.ui + '#!/?' + hash;
    deadline = Date.now() + 60000;
    timer = setInterval(() => {
      if (Date.now() >= deadline) {
        stop();
        fail(
          Error(
            'Perfetto did not respond within 60 seconds. Check network or --perfetto-ui; use Reload viewer to retry.',
          ),
        );
        return;
      }
      frame.contentWindow.postMessage('PING', origin);
    }, 200);
  };
  window.addEventListener('message', (event) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      event.data !== 'PONG' ||
      ready
    )
      return;
    stop();
    ready = true;
    frame.contentWindow.postMessage(
      {
        perfetto: {
          buffer: bytes.slice(0),
          title: meta.title,
          fileName: 'timeline.trace.json',
          shareable: false,
          downloadable: true,
          keepApiOpen: true,
        },
      },
      origin,
    );
    el('status').textContent =
      'Trace sent to Perfetto. Loading/parse progress appears below. Data remains in this browser; sharing is disabled.';
    if (meta.endMs > meta.startMs) range();
  });
  el('range').onclick = guard(range);
  el('full').onclick = guard(() => {
    el('from').value = meta.startMs;
    el('to').value = meta.endMs;
    range();
  });
  el('frame').onchange = guard(() => {
    const f = meta.frames[Number(el('frame').value)];
    if (el('frame').value !== '' && f) {
      el('from').value = f.startMs;
      el('to').value = f.endMs;
      range();
    }
  });
  el('retry').onclick = guard(open);
  el('load').onchange = guard(async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const current = ++generation,
      buffer = await file.arrayBuffer();
    let data = buffer,
      next = null;
    if (file.name.endsWith('.json')) {
      const value = JSON.parse(new TextDecoder().decode(buffer));
      if (!Array.isArray(value.traceEvents) && !Array.isArray(value)) {
        if (!normalizeInput) throw Error('Expected Chrome trace JSON');
        const converted = normalizeInput(value, convertTimeline);
        data = new TextEncoder().encode(JSON.stringify(converted.trace)).buffer;
        next = { ...initial, ...converted.metadata, traceSha256: null };
      }
    }
    if (current !== generation) return;
    bytes = data;
    // Arbitrary external trace clocks are unknown to the wrapper; Perfetto owns their range.
    meta = next ?? {
      ...initial,
      identity: { file: file.name },
      frames: [],
      startMs: 0,
      endMs: 0,
      fromMs: 0,
      toMs: 0,
      traceSha256: null,
    };
    fill();
    open();
  });
  window.addEventListener('pagehide', stop);
  if (location.protocol === 'file:') {
    fail(
      Error(
        'Serve this report over HTTP with the report tool serve command; open the printed loopback URL.',
      ),
    );
    return;
  }
  guard(async () => {
    const payload = el('trace-data');
    bytes = await new Response(
      new Blob([Uint8Array.from(atob(payload.textContent), (c) => c.charCodeAt(0))])
        .stream()
        .pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer();
    payload.remove();
    fill();
    open();
  })();
}

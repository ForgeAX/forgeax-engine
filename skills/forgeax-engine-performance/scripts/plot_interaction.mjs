/** Zoom about an SVG-space anchor; no data values or units are transformed. */
export function zoomPlotBox(box, factor, x, y) {
  if (![...box, factor, x, y].every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || factor <= 0)
    throw Error('Invalid plot zoom');
  return [x - (x - box[0]) / factor, y - (y - box[1]) / factor, box[2] / factor, box[3] / factor];
}

/** Attach once to a host whose SVG is replaced by its owning renderer. */
export function mountSvgControls(host, { selector, describe }) {
  const tools = document.createElement('div');
  tools.className = 'plot-tools';
  tools.innerHTML =
    '<button type="button" data-zoom="in">Zoom +</button><button type="button" data-zoom="out">Zoom −</button><button type="button" data-zoom="fit">Fit</button><span> Hover for details · click to inspect · Ctrl+wheel to zoom · Shift+drag to pan</span>';
  host.before(tools);
  const tip = document.createElement('pre');
  tip.className = 'plot-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  Object.assign(tip.style, {
    position: 'fixed',
    zIndex: '1000',
    pointerEvents: 'none',
    maxWidth: '520px',
    maxHeight: '360px',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    background: '#10233b',
    color: '#edf5ff',
    border: '1px solid #7594b7',
    borderRadius: '6px',
    padding: '12px',
    font: '13px/1.5 system-ui',
    boxShadow: '0 6px 22px #0009',
  });
  document.body.append(tip);
  let enabled = true;
  let original = null,
    box = null,
    dragging = null,
    suppressClick = false;
  const svg = () => host.querySelector('svg');
  const apply = () => svg()?.setAttribute('viewBox', box.join(' '));
  const reset = () => {
    const image = svg();
    if (!image) return;
    original = [0, 0, Number(image.getAttribute('width')), Number(image.getAttribute('height'))];
    box = [...original];
    apply();
    tip.hidden = true;
  };
  const point = (event) => {
    const p = svg().createSVGPoint();
    p.x = event.clientX;
    p.y = event.clientY;
    return p.matrixTransform(svg().getScreenCTM().inverse());
  };
  const zoom = (factor, anchor) => {
    if (!box) reset();
    const scale = Math.min(32, Math.max(0.25, (original[2] / box[2]) * factor));
    const p = anchor ?? { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 };
    box = zoomPlotBox(box, scale / (original[2] / box[2]), p.x, p.y);
    apply();
    tip.hidden = true;
  };
  tools.onclick = (event) => {
    const action = event.target.closest('[data-zoom]')?.dataset.zoom;
    if (action === 'fit') reset();
    if (action === 'in') zoom(1.5);
    if (action === 'out') zoom(1 / 1.5);
  };
  host.addEventListener(
    'wheel',
    (event) => {
      if (!enabled || !event.ctrlKey || !svg()) return;
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.2 : 1 / 1.2, point(event));
    },
    { passive: false },
  );
  host.addEventListener('pointerdown', (event) => {
    if (!enabled) return;
    suppressClick = false;
    if ((!event.shiftKey && event.button !== 1) || !svg()) return;
    event.preventDefault();
    dragging = {
      x: event.clientX,
      y: event.clientY,
      box: [...box],
      width: svg().getBoundingClientRect().width,
      height: svg().getBoundingClientRect().height,
    };
    host.setPointerCapture(event.pointerId);
  });
  host.addEventListener('pointermove', (event) => {
    if (!enabled) return;
    if (dragging) {
      const dx = event.clientX - dragging.x,
        dy = event.clientY - dragging.y;
      box = [
        dragging.box[0] - (dx / dragging.width) * dragging.box[2],
        dragging.box[1] - (dy / dragging.height) * dragging.box[3],
        ...dragging.box.slice(2),
      ];
      apply();
      suppressClick = true;
      tip.hidden = true;
      return;
    }
    const element = event.target.closest(selector);
    if (!element) {
      tip.hidden = true;
      return;
    }
    tip.textContent = describe(element);
    tip.hidden = !tip.textContent;
    tip.style.left =
      Math.max(8, Math.min(event.clientX + 16, window.innerWidth - tip.offsetWidth - 8)) + 'px';
    tip.style.top =
      Math.max(8, Math.min(event.clientY + 16, window.innerHeight - tip.offsetHeight - 8)) + 'px';
  });
  const stop = () => {
    dragging = null;
  };
  host.addEventListener('pointerup', stop);
  host.addEventListener('pointercancel', stop);
  host.addEventListener('pointerleave', () => {
    tip.hidden = true;
  });
  host.addEventListener(
    'click',
    (event) => {
      if (!enabled || !suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  host.addEventListener('keydown', (event) => {
    if (!enabled) return;
    const element = event.target.closest(selector);
    if (!element || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return {
    reset,
    setEnabled(value) {
      enabled = value;
      tools.hidden = !value;
      tip.hidden = true;
      dragging = null;
      suppressClick = false;
    },
  };
}

import quality from './render-quality.json' with { type: 'json' };

// Keep CSS layout, input coordinates and screenshots intact while bounding the
// real App drawing buffer. Explicit canvas attributes override the test default.
export function applyTestCanvasBudget({ width, height }) {
  const apply = (canvas) => {
    if (!canvas.hasAttribute('data-forgeax-render-width-limit'))
      canvas.setAttribute('data-forgeax-render-width-limit', String(width));
    if (!canvas.hasAttribute('data-forgeax-render-height-limit'))
      canvas.setAttribute('data-forgeax-render-height-limit', String(height));
  };
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('canvas')) apply(node);
        node.querySelectorAll('canvas').forEach(apply);
      }
  }).observe(document, { childList: true, subtree: true });
  document.querySelectorAll('canvas').forEach(apply);
}

export async function installTestCanvasBudget(context, viewport = quality.viewport) {
  await context.addInitScript(applyTestCanvasBudget, viewport);
}

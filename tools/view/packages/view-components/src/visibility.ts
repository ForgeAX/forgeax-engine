/** Derive presentation activity from the actual DOM, without a second page ledger. */
export function observeElementVisibility(element: HTMLElement, publish: (visible: boolean) => void) {
  const document = element.ownerDocument;
  const realm = document.defaultView!;
  let previous: boolean | undefined;
  const update = () => {
    const visible = element.isConnected && document.visibilityState !== 'hidden'
      && !element.closest('[hidden], [inert], [aria-hidden="true"]')
      && element.getClientRects().length > 0
      && realm.getComputedStyle(element).visibility !== 'hidden';
    if (visible !== previous) { previous = visible; publish(visible); }
  };
  const resize = new realm.ResizeObserver(update);
  resize.observe(element);
  const mutations = new realm.MutationObserver(update);
  // Page and drawer visibility live on ancestors. Text and selection mutations
  // inside the panel do not belong to this observation.
  for (let parent: Element | null = element; parent; parent = parent.parentElement)
    mutations.observe(parent, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden'] });
  document.addEventListener('visibilitychange', update);
  update();
  return () => { resize.disconnect(); mutations.disconnect(); document.removeEventListener('visibilitychange', update); };
}

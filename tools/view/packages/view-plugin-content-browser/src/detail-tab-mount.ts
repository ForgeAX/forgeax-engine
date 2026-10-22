import type { ContentBrowserDetailContext, ContentBrowserDetailContribution } from '@forgeax/view-workspace-core/frontend-contract';

export function mountDetailTabContribution(
  container: HTMLElement,
  contribution: ContentBrowserDetailContribution,
  context: ContentBrowserDetailContext,
  onError: (error: unknown) => void,
): () => void {
  const element = container.ownerDocument.createElement('div');
  container.append(element);
  let active = true;
  let dispose: (() => void | Promise<void>) | undefined;
  let mounting: Promise<() => void | Promise<void>>;
  try {
    mounting = Promise.resolve(contribution.mount(element, context));
  } catch (error) {
    mounting = Promise.reject(error);
  }
  void mounting.then(unmount => {
    if (!active) {
      return Promise.resolve().then(unmount).catch(() => {}).finally(() => element.remove());
    }
    dispose = unmount;
  }).catch(error => {
    if (active) onError(error);
    element.remove();
  });
  return () => {
    active = false;
    const unmount = dispose;
    dispose = undefined;
    if (!unmount) {
      element.remove();
      return;
    }
    void Promise.resolve().then(unmount).catch(() => {}).finally(() => element.remove());
  };
}

export type CardResource = { path: string; label: string };

/** Inline resource actions yield to ordinary View when this App expands. */
export function createResourceCard(activate: (resource: CardResource) => Promise<void>,
  report: (error: unknown) => void) {
  const element = document.createElement('section');
  element.id = 'resource-card';
  element.setAttribute('aria-label', 'ForgeAX View resources');
  const resources = document.createElement('nav');
  resources.setAttribute('aria-label', 'Asset sources');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Preparing resource buttons…';
  element.append(resources, status);
  document.body.prepend(element);
  let pending = false;
  return {
    element,
    update(input: unknown) {
      if (!Array.isArray(input) || input.length < 1 || input.length > 8
        || input.some(value => typeof value?.path !== 'string' || typeof value?.label !== 'string'))
        throw new Error('The resource card did not receive valid asset sources.');
      resources.replaceChildren();
      for (const resource of input as CardResource[]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = resource.label;
        button.title = resource.path;
        button.dataset.sourcePath = resource.path;
        button.addEventListener('click', () => {
          if (pending) return;
          pending = true;
          status.setAttribute('role', 'status');
          status.hidden = false;
          status.textContent = 'Opening asset source…';
          for (const action of resources.querySelectorAll('button')) action.disabled = true;
          void activate(resource).then(() => {
            status.textContent = '';
            status.hidden = true;
            for (const action of resources.querySelectorAll('button'))
              action.setAttribute('aria-pressed', String(action === button));
          }).catch(error => {
            status.setAttribute('role', 'alert');
            status.textContent = error instanceof Error ? error.message : String(error);
            report(error);
          }).finally(() => {
            pending = false;
            for (const action of resources.querySelectorAll('button')) action.disabled = false;
          });
        });
        resources.append(button);
      }
      status.textContent = '';
      status.setAttribute('role', 'status');
      status.hidden = true;
    },
  };
}

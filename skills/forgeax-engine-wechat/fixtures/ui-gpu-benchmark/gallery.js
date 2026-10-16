import { composedGalleryHtml, mountComposedGallery } from '@probe/gallery-scene';
import imageUrl from '@probe/gallery-image';

export const html = composedGalleryHtml(imageUrl);
export const fontFamily = 'Image Fixture';

export function mount(document, { now, rect, point }) {
  const get = (id) => {
    const element = document.querySelector(id);
    if (!element) throw new Error(`Missing gallery element ${id}`);
    return element;
  };
  const images = Array.from(document.querySelectorAll('img'));
  const dispose = mountComposedGallery(document);
  const actions = [];
  for (const id of ['#open', '#close'])
    get(id).addEventListener('click', () => {
      const action = {
        id,
        time: now(),
        modalOpen: !get('#overlay').hidden,
        scrollTop: get('#scroll').scrollTop,
      };
      actions.push(action);
      if (actions.length > 32) actions.shift();
      console.info('FORGEAX_UI_GALLERY_ACTION', JSON.stringify(action));
    });
  return {
    dispose,
    scrollTo: (top) => {
      get('#scroll').scrollTop = top;
    },
    display({ width: viewportWidth, height: viewportHeight, safeArea }) {
      const { x, y, width, height } = safeArea;
      const padding = `${y}px ${viewportWidth - x - width}px ${viewportHeight - y - height}px ${x}px`;
      get('#page').style.padding = padding;
      get('#overlay').style.padding = padding;
    },
    snapshot() {
      const scroll = get('#scroll');
      return {
        modalOpen: !get('#overlay').hidden,
        pageInert: get('#page').inert,
        sameImages:
          images.length === document.querySelectorAll('img').length &&
          images.every((image, i) => image === document.querySelectorAll('img')[i]),
        scroll: {
          top: scroll.scrollTop,
          height: scroll.scrollHeight,
          client: scroll.clientHeight,
        },
        geometry: Array.from(
          document.querySelectorAll('#toolbar,#scroll,.card,img,#modal,#open,#close'),
          (element) => ({ id: element.id, ...rect(element) }),
        ),
        points: {
          open: point(get('#open')),
          close: point(get('#close')),
          scroll: point(scroll),
        },
        actions: actions.slice(),
      };
    },
  };
}

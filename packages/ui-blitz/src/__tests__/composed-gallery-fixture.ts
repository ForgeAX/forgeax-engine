/** One retained scene for browser differentials and native GPU UI diagnostics. */
export function composedGalleryHtml(imageUrl: string): string {
  const fits = ['fill', 'cover', 'contain', 'none', 'scale-down', 'none'];
  return `<!doctype html><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font:13px/20px "Image Fixture";color:#eef2fa;background:#10243a}
    #page{height:100%;display:flex;flex-direction:column}
    #toolbar{height:48px;flex-shrink:0;padding:8px 12px;display:flex;align-items:center;gap:12px;background:#1d3852}
    button{font:inherit;color:#10243a;background:#f7c62d;border:0;border-radius:4px;height:30px;padding:4px 12px}
    #scroll{flex:1;min-height:0;overflow:auto;padding:12px}
    #cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .card{min-width:0;display:flex;flex-direction:column;padding:8px;gap:8px;background:#274460;border-radius:7px}
    .card header{display:flex;justify-content:space-between;align-items:center;height:20px}
    .tag{font-size:10px;color:#c6d3e2}
    img{display:block;width:100%;height:96px;padding:8px;border:4px solid #8097af;background:#15202c;image-rendering:pixelated}
    #image5{object-position:7px 9px}
    .caption{height:40px;color:#c6d3e2}
    #tail{height:100px;margin-top:12px;display:flex;align-items:center;justify-content:center;background:#1d3852}
    #overlay{position:fixed;inset:0;z-index:10;display:grid;place-items:center;background:rgba(5,12,23,.7)}
    #overlay[hidden]{display:none}
    #modal{width:280px;max-width:calc(100% - 32px);padding:14px;display:flex;flex-direction:column;gap:12px;background:#274460;border:2px solid #8097af;border-radius:9px}
    #modal header{display:flex;align-items:center;justify-content:space-between}
    #preview{height:132px;padding:10px;object-fit:none}
    @media(max-width:520px){#cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style><div id=page><header id=toolbar><strong>Image gallery</strong><button id=open>Preview</button></header>
  <main id=scroll><section id=cards>${fits.map((fit, i) => `<article class=card id=card${i}><header><span>${fit}</span><span class=tag>${i + 1}/6</span></header><img id=image${i} src="${imageUrl}" style="object-fit:${fit}"><div class=caption>Prepared PNG<br>60 x 30 pixels</div></article>`).join('')}</section><footer id=tail>Gallery end</footer></main></div>
  <div id=overlay hidden><section id=modal><header><strong>Native size</strong><button id=close>Close</button></header><img id=preview src="${imageUrl}"><div>Same image, retained document</div></section></div>`;
}

export function mountComposedGallery(document: Document): () => void {
  const get = (id: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(id);
    if (!element) throw new Error(`Missing gallery element ${id}`);
    return element;
  };
  const overlay = get('#overlay');
  const main = get('#page');
  const open = get('#open');
  const close = get('#close');
  const show = () => {
    overlay.hidden = false;
    main.inert = true;
  };
  const hide = () => {
    overlay.hidden = true;
    main.inert = false;
  };
  open.addEventListener('click', show);
  close.addEventListener('click', hide);
  return () => {
    open.removeEventListener('click', show);
    close.removeEventListener('click', hide);
  };
}

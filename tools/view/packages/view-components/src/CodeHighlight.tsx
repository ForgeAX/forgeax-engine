import { useEffect, useState } from 'react';
import { highlightToHtml, type HighlightAppearance } from './code-highlighter';

function documentAppearance(): HighlightAppearance {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function CodeHighlight({ content, lang, name, wrap = true }: {
  content: string;
  lang: string | null;
  name?: string;
  wrap?: boolean;
}) {
  const [appearance, setAppearance] = useState<HighlightAppearance>(documentAppearance);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setAppearance(documentAppearance()));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setHtml(null);
    if (!lang || content.length > 200 * 1024) return;
    let cancelled = false;
    void highlightToHtml(content, lang, appearance)
      .then((result) => { if (!cancelled) setHtml(result); })
      .catch(() => { if (!cancelled) setHtml(null); });
    return () => { cancelled = true; };
  }, [appearance, content, lang]);

  return <div className={`fx-code-highlight${wrap ? '' : ' fx-code-highlight--nowrap'}`}>
    {html != null
      ? <div dangerouslySetInnerHTML={{ __html: html }} />
      : <pre aria-label={name}>{content}</pre>}
  </div>;
}

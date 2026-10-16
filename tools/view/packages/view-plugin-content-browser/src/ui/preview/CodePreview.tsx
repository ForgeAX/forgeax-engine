import { CodeHighlight } from '@forgeax/view-components';
import { useTranslation } from '../../i18n/useTranslation';
import { decideHighlight } from './code-preview-policy';
import { resolveLanguage } from './ext-language';

export function CodePreview({
  name,
  ext,
  size,
  content,
}: {
  name: string;
  ext: string;
  size: number;
  content: string;
}) {
  const { t } = useTranslation();
  const decision = decideHighlight({ ext, size, content });
  const targetLang = decision.highlight ? decision.lang : null;
  const label = resolveLanguage(ext)?.label ?? ext.toUpperCase();

  const skippedForSize = !decision.highlight && decision.reason === 'too-large';

  return (
    <div className="cb-preview-code" data-lang={resolveLanguage(ext)?.lang ?? 'text'}>
      <div className="cb-preview-code-head">
        <span className="cb-preview-code-badge">{label}</span>
        {skippedForSize ? <span className="cb-preview-code-hint">{t('contentBrowser.preview.highlightSkipped')}</span> : null}
      </div>
      <CodeHighlight content={content} lang={targetLang} name={name} />
    </div>
  );
}

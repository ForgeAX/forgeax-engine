import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { wgslHighlighting, wgslLanguage } from './wgsl-language';

export interface CodeMirrorWidgetProps {
  readonly wgslCode: string;
}

export function CodeMirrorWidget({ wgslCode }: CodeMirrorWidgetProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!host.current) return;
    view.current?.destroy();
    host.current.replaceChildren();
    if (wgslCode === '') return;
    view.current = new EditorView({
      state: EditorState.create({
        doc: wgslCode,
        extensions: [wgslLanguage, wgslHighlighting, EditorState.readOnly.of(true)],
      }),
      parent: host.current,
    });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, [wgslCode]);
  return (
    <div ref={host} className="max-h-64 overflow-auto rounded border border-border text-code" />
  );
}

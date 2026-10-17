import type { Meta, StoryObj } from '@storybook/react-vite';
import { useCallback, useState } from 'react';
import { PageTabStrip, type PageTabItem } from './PageTabStrip';
import { Surface, Text } from './components';

const meta = {
  title: 'Workspace Patterns/Page Tab Strip',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '文档页标签条，从 forgeax-interface 的 PageTabStrip 迁移而来，仅使用 view-components 主题 token。',
      },
    },
  },
} satisfies Meta;

export default meta;

const NEW_TYPES = [
  { typeId: 'scene', title: '场景' },
  { typeId: 'notes', title: '笔记' },
];

function PageTabsDemo() {
  const [pages, setPages] = useState<PageTabItem[]>([
    { id: 'scene-1', title: 'Scene', typeId: 'scene', closable: false },
    { id: 'notes-1', title: '设计备忘', typeId: 'notes', resourcePath: 'docs/notes.md' },
  ]);
  const [activePageId, setActivePageId] = useState('scene-1');

  const closeOthers = useCallback((pageId: string) => {
    setPages((current) => current.filter((page) => page.id === pageId || page.closable === false));
  }, []);

  const closeToRight = useCallback((pageId: string) => {
    setPages((current) => {
      const index = current.findIndex((page) => page.id === pageId);
      if (index < 0) return current;
      return current.filter((page, i) => i <= index || page.closable === false);
    });
  }, []);

  const active = pages.find((page) => page.id === activePageId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 480 }}>
      <PageTabStrip
        pages={pages}
        activePageId={activePageId}
        onSelect={setActivePageId}
        onClose={(pageId) => {
          setPages((current) => current.filter((page) => page.id !== pageId));
          setActivePageId((current) => {
            if (current !== pageId) return current;
            const remaining = pages.filter((page) => page.id !== pageId);
            return remaining[0]?.id ?? null;
          });
        }}
        onCloseOthers={closeOthers}
        onCloseToRight={closeToRight}
        onReorder={(pageId, toIndex) => {
          setPages((current) => {
            const fromIndex = current.findIndex((page) => page.id === pageId);
            if (fromIndex < 0 || fromIndex === toIndex) return current;
            const next = [...current];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, moved);
            return next;
          });
        }}
        newPageTypes={NEW_TYPES}
        onNewPage={(typeId) => {
          const id = `${typeId}-${Date.now()}`;
          const title = typeId === 'scene' ? 'Scene' : '新笔记';
          setPages((current) => [
            ...current,
            { id, title, typeId, closable: typeId !== 'scene' },
          ]);
          setActivePageId(id);
        }}
      />
      <Surface tone="inset" style={{ flex: 1, padding: 24 }}>
        <Text as="h2" variant="heading">
          {active?.title ?? '无页面'}
        </Text>
        <Text tone="muted">typeId: {active?.typeId}</Text>
      </Surface>
    </div>
  );
}

export const Default: StoryObj = {
  render: () => <PageTabsDemo />,
};

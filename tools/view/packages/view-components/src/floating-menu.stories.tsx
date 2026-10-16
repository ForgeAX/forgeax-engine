import type { Meta, StoryObj } from '@storybook/react-vite';
import { ArrowUpDown, CaseSensitive, Copy, Filter, Folder, FolderOpen, LayoutGrid, Shapes } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  Button,
  ContextMenu,
  FloatingMenu,
  Menu,
  Text,
  type MenuItem,
} from './components';

const meta = {
  title: 'Overlays/FloatingMenu',
  component: FloatingMenu,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Anchored floating shell for Menu panels. Measures the menu, then places it with `resolveFloatingMenuPosition`: preferred order right → left → bottom → top, 8px gap from the anchor, top-aligned for horizontal placements and horizontally centered for vertical placements. Viewport overflow picks the next side instead of sliding the menu over the anchor.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const sampleItems: MenuItem[] = [
  { type: 'title', label: '排序方式' },
  {
    id: 'name',
    label: '名称',
    icon: <CaseSensitive className="fx-icon" />,
    selected: true,
    onSelect: () => undefined,
  },
  {
    id: 'kind',
    label: '类型',
    icon: <Shapes className="fx-icon" />,
    onSelect: () => undefined,
  },
];

function ToolbarAnchorDemo() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Button
        ref={triggerRef}
        size="compact"
        variant="quiet"
        leadingIcon={<ArrowUpDown className="fx-icon" />}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setAnchor(triggerRef.current?.getBoundingClientRect() ?? null);
          setOpen(true);
        }}
      >
        名称
      </Button>
      <Text tone="muted" variant="caption">菜单左上角对齐触发器右上角，并保留间距</Text>
      <FloatingMenu
        open={open}
        anchorRect={anchor}
        onClose={() => setOpen(false)}
        ignorePointerWithin={[triggerRef]}
      >
        <Menu label="排序" items={sampleItems} />
      </FloatingMenu>
    </div>
  );
}

const cardMenuItems: MenuItem[] = [
  { type: 'title', label: 'FORGE.md' },
  {
    id: 'open',
    label: '打开编辑器',
    icon: <FolderOpen className="fx-icon" />,
    onSelect: () => undefined,
  },
  { id: 'copy-guid', label: '复制 GUID', icon: <Copy className="fx-icon" />, onSelect: () => undefined },
];

function CardAnchorDemo() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        style={{
          width: 120,
          padding: 12,
          border: '1px solid var(--fx-color-border-default)',
          borderRadius: 'var(--fx-radius-card)',
          background: 'var(--fx-color-surface-raised)',
          textAlign: 'center',
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setAnchor(event.currentTarget.getBoundingClientRect());
        }}
      >
        <strong>FORGE.md</strong>
        <div><Text tone="muted" variant="caption">右键卡片</Text></div>
      </div>
      <ContextMenu
        open={anchor !== null}
        anchorRect={anchor}
        items={cardMenuItems}
        onClose={() => setAnchor(null)}
        label="卡片操作"
      />
    </>
  );
}

function EdgeFlipDemo() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
      <Button
        ref={triggerRef}
        size="compact"
        variant="quiet"
        leadingIcon={<Filter className="fx-icon" />}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setAnchor(triggerRef.current?.getBoundingClientRect() ?? null);
          setOpen(true);
        }}
      >
        筛选
      </Button>
      <FloatingMenu
        open={open}
        anchorRect={anchor}
        onClose={() => setOpen(false)}
        ignorePointerWithin={[triggerRef]}
      >
        <Menu
          label="筛选"
          items={[
            { type: 'title', label: '类型' },
            {
              id: 'all',
              label: '全部',
              icon: <LayoutGrid className="fx-icon" />,
              selected: true,
              onSelect: () => undefined,
            },
            {
              id: 'folder',
              label: '文件夹',
              icon: <Folder className="fx-icon" />,
              onSelect: () => undefined,
            },
          ]}
        />
      </FloatingMenu>
    </div>
  );
}

export const ToolbarAnchor: Story = {
  name: '工具栏锚点',
  render: () => <ToolbarAnchorDemo />,
};

export const CardContextAnchor: Story = {
  name: '卡片右键锚点',
  render: () => <CardAnchorDemo />,
};

export const ViewportFlip: Story = {
  name: '贴边自动换向',
  render: () => <EdgeFlipDemo />,
};

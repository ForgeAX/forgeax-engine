import type { Meta, StoryObj } from '@storybook/react-vite';
import { Copy, MessageSquareText, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  Button,
  ContextMenu,
  Dialog,
  Field,
  OverlayRootProvider,
  Text,
  TextInput,
  type MenuItem,
} from './components';

const meta = {
  title: 'Overlays/Dialog and Context',
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'ContextMenu supports `anchorRect` (preferred, uses FloatingMenu placement) or fixed `x`/`y` for cursor coordinates. Dialog is centered over a scrim. The default dialog closes on Esc or the header control and returns focus to the trigger. Set `dismissible={false}` to hide the close control and ignore Esc until the owner unmounts the dialog.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const menuItems: MenuItem[] = [
  { type: 'title', label: '资源操作' },
  { id: 'copy', label: '复制路径', icon: <Copy className="fx-icon" />, shortcut: 'Ctrl+C' },
  {
    id: 'reference',
    label: '在对话中引用',
    icon: <MessageSquareText className="fx-icon" />,
  },
  { type: 'separator' },
  { id: 'delete', label: '删除资源', icon: <Trash2 className="fx-icon" />, danger: true },
];

function ContextMenuAnchorDemo() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <div
        tabIndex={0}
        style={{
          minHeight: 180,
          padding: 24,
          border: '1px dashed var(--fx-color-border-essential)',
          borderRadius: 'var(--fx-radius-card)',
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setAnchor(event.currentTarget.getBoundingClientRect());
        }}
      >
        在这个区域点击右键（菜单锚定区域右上角）
      </div>
      <ContextMenu
        open={anchor !== null}
        anchorRect={anchor}
        items={menuItems}
        onClose={() => setAnchor(null)}
      />
    </>
  );
}

function ContextMenuCursorDemo() {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <div
        tabIndex={0}
        style={{
          minHeight: 180,
          padding: 24,
          border: '1px dashed var(--fx-color-border-essential)',
          borderRadius: 'var(--fx-radius-card)',
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setPoint({ x: event.clientX, y: event.clientY });
        }}
      >
        在这个区域点击右键（光标锚点，固定 x/y）
      </div>
      <ContextMenu
        open={point !== null}
        x={point?.x ?? 0}
        y={point?.y ?? 0}
        items={menuItems}
        onClose={() => setPoint(null)}
      />
    </>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>打开导出设置</Button>
      <Dialog
        open={open}
        title="导出角色"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => setOpen(false)}>导出资源</Button>
          </>
        }
      >
        关闭弹窗后，键盘焦点会返回触发按钮。按 Esc 也可以关闭。
      </Dialog>
    </>
  );
}

export const ContextMenuAnchored: Story = {
  name: '右键菜单（锚定目标）',
  render: () => <ContextMenuAnchorDemo />,
};

export const ContextMenuCursor: Story = {
  name: '右键菜单（光标锚点）',
  render: () => <ContextMenuCursorDemo />,
};

export const DialogFocusLifecycle: Story = {
  name: '弹窗焦点',
  render: () => <DialogDemo />,
};

function RequiredDialogDemo() {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog
      open
      dismissible={false}
      title="打开项目"
      initialFocusRef={inputRef}
      footer={(
        <Button
          form="story-open-project"
          type="submit"
          variant="primary"
          loading={busy}
          disabled={busy || !path.trim()}
        >
          {busy ? '正在打开…' : '打开项目'}
        </Button>
      )}
    >
      <form
        id="story-open-project"
        onSubmit={(event) => {
          event.preventDefault();
          if (!path.trim() || busy) return;
          setBusy(true);
          setError(undefined);
          window.setTimeout(() => {
            setBusy(false);
            setError('演示：提交后对话框保持打开，直到宿主卸载它。');
          }, 1600);
        }}
      >
        <Text variant="body" tone="secondary">
          编辑器需要先指定项目目录。此对话框在打开成功前无法关闭。
        </Text>
        <Field label="项目路径" htmlFor="story-project-path" error={error}>
          <TextInput
            id="story-project-path"
            ref={inputRef}
            value={path}
            placeholder="项目目录的绝对路径"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setPath(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

export const RequiredDialog: Story = {
  name: '不可关闭',
  parameters: {
    docs: {
      description: {
        story:
          'Required dialogs omit the close control, ignore Esc, and keep focus inside until the owner unmounts them. Use Field, a single primary footer action, and inline field errors.',
      },
    },
  },
  render: () => <RequiredDialogDemo />,
};

function OwnedOverlayExample() {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return <div ref={setRoot} data-testid="overlay-owner" style={{ minHeight: 240 }}>
    {root && <OverlayRootProvider root={root}>
      <Button onClick={event => setAnchor(event.currentTarget.getBoundingClientRect())}>Open owned overlay</Button>
      <ContextMenu open={anchor !== null} anchorRect={anchor} items={menuItems} onClose={() => setAnchor(null)} />
    </OverlayRootProvider>}
  </div>;
}
export const OwnedOverlay: Story = {
  parameters: { docs: { description: { story: 'The embedding owner supplies an overlay root. Menus and tooltips stay under that root and are removed with their React owner. Standalone consumers retain the document body default.' } } },
  render: () => <OwnedOverlayExample />,
};

function ModelessDialogDemo() {
  const [open, setOpen] = useState(true);
  const [visits, setVisits] = useState(0);
  return (
    <>
      <Button onClick={() => setVisits(value => value + 1)}>Inspect artifact ({visits})</Button>
      <Button onClick={() => setOpen(true)}>Open project</Button>
      <Dialog open={open} modal={false} title="Open project" onClose={() => setOpen(false)}>
        The surrounding workspace remains interactive while this dialog is open.
      </Dialog>
    </>
  );
}

export const ModelessWorkspaceDialog: Story = {
  name: 'Modeless workspace dialog',
  parameters: { docs: { description: { story: 'Use modal=false for page-local admission that must leave workspace navigation available. Modal dialogs remain the default.' } } },
  render: () => <ModelessDialogDemo />,
};

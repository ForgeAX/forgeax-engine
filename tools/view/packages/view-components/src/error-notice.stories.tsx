import {ClipboardProvider} from './clipboard';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './components';
import {
  ErrorNotice,
  ErrorNoticeHost,
  ErrorNoticeStack,
  showErrorNotice,
  type ErrorNoticeItem,
} from './ErrorNotice';
import { SpecSection } from './storybook/Specimens';

const SCENE_OPEN_ERROR = {
  title: '工作区命令失败（asset.open）',
  code: 'view-workspace-browser-failure',
  description: 'workspace asset is required',
  details:
    '{\n  "name": "ViewWorkspaceError",\n  "message": "view-workspace-browser-failure: workspace asset is required",\n  "code": "view-workspace-browser-failure",\n  "hint": "workspace asset is required",\n  "detail": {\n    "failure": {\n      "code": "tool-domain-failed",\n      "hint": "engine-workspace-browser-failure: workspace asset is required",\n      "detail": { "code": "executor-threw" }\n    }\n  }\n}',
  copyText:
    'operation: asset.open\ncode: view-workspace-browser-failure\ndescription: workspace asset is required\n\n{\n  "name": "ViewWorkspaceError",\n  "message": "view-workspace-browser-failure: workspace asset is required",\n  "code": "view-workspace-browser-failure",\n  "hint": "workspace asset is required",\n  "detail": {\n    "failure": {\n      "code": "tool-domain-failed",\n      "hint": "engine-workspace-browser-failure: workspace asset is required",\n      "detail": { "code": "executor-threw" }\n    }\n  }\n}',
} as const;

const meta = {
  title: 'Feedback/Error Notice',
  // Native details starts open and remains keyboard-toggleable.
  component: ErrorNotice,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '核心错误通知：右上角浮层，默认不自动关闭，必须点关闭。用于工作区转发到后端的命令失败。正文展示真实诊断，详细信息默认展开，可一键复制完整诊断，不替换、不省略原始错误。同时出现多条时上下叠成一摞，后方露出等高边缘；悬停或聚焦向下展开，离开向上收起，关闭后下方卡片上移补位。',
      },
    },
  },
  args: {
    ...SCENE_OPEN_ERROR,
    onClose: () => {},
  },
} satisfies Meta<typeof ErrorNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Card: Story = {
  name: '错误卡片',
  render: (args) => (
    <SpecSection
      title="核心错误卡片"
      description="静态标本：标题、错误码、真实诊断和默认展开的原始详情。关闭按钮始终可见。"
    >
      <div style={{ width: 'min(420px, 100%)' }}>
        <ErrorNotice {...args} />
      </div>
    </SpecSection>
  ),
};

function OverlayDemo() {
  return (
    <SpecSection
      title="右上角浮层"
      description="点按钮后出现在视口右上角，不会自动消失。多条同时打开时上下叠成一摞；悬停向下展开，离开向上收起，关闭后下方卡片上移。正文是真实错误，详情默认展开。点通知上的关闭才会收起。"
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          onClick={() =>
            showErrorNotice({
              ...SCENE_OPEN_ERROR,
              persistent: true,
            })
          }
        >
          打开场景失败
        </Button>
        <Button
          onClick={() =>
            showErrorNotice({
              title: '工作区命令失败（assets.list）',
              code: 'view-workspace-unauthorized',
              description: 'workspace token to authorize this operation',
              hint: 'Connect with the issued token.',
              persistent: true,
            })
          }
        >
          列出资产失败
        </Button>
        <Button
          onClick={() => {
            showErrorNotice({
              ...SCENE_OPEN_ERROR,
              persistent: true,
            });
            showErrorNotice({
              title: '工作区命令失败（assets.list）',
              code: 'view-workspace-unauthorized',
              description: 'workspace token to authorize this operation',
              hint: 'Connect with the issued token.',
              persistent: true,
            });
            showErrorNotice({
              title: '工作区命令失败（entity.inspect）',
              code: 'view-workspace-page-lost',
              description: 'the Engine workspace browser page to remain connected',
              hint: 'The headed page was destroyed or navigated away; reopen the project instead of replaying commands.',
              persistent: true,
            });
          }}
        >
          同时打开多条
        </Button>
      </div>
      <ErrorNoticeHost />
    </SpecSection>
  );
}

export const Overlay: Story = {
  name: '浮层通知（需手动关闭）',
  render: () => <OverlayDemo />,
};

export const Stacked: Story = {
  name: '卡片堆叠',
  render: () => <StackedDemo />,
};

function StackedDemo() {
  const [items, setItems] = useState<ErrorNoticeItem[]>(() => [
    {
      id: 3,
      persistent: true,
      ...SCENE_OPEN_ERROR,
    },
    {
      id: 2,
      persistent: true,
      title: '工作区命令失败（assets.list）',
      code: 'view-workspace-unauthorized',
      description: 'workspace token to authorize this operation',
      hint: 'Connect with the issued token.',
    },
    {
      id: 1,
      persistent: true,
      title: '工作区命令失败（entity.inspect）',
      code: 'view-workspace-page-lost',
      description: 'the Engine workspace browser page to remain connected',
      hint: 'The headed page was destroyed or navigated away; reopen the project instead of replaying commands.',
    },
  ]);

  return (
    <SpecSection
      title="卡片堆叠"
      description="上下叠成一摞，后方露出等高边缘。悬停向下展开，离开向上收起；关闭最前一张时，被盖住的卡片上移补位。"
    >
      <ErrorNoticeStack
        items={items}
        inline
        onClose={(id) => setItems((current) => current.filter((item) => item.id !== id))}
      />
    </SpecSection>
  );
}

export const ClipboardDenied: Story = {
  parameters: { docs: { description: { story: 'Clipboard failures stay visible beside the original diagnostic. The injected clipboard capability owns the actual write.' } } },
  render: args => (
    <ClipboardProvider writeText={async () => { throw new Error('Clipboard permission denied'); }}>
      <ErrorNotice {...args} />
    </ClipboardProvider>
  ),
};

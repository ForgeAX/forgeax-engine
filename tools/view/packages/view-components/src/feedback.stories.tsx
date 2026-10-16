import type { Meta, StoryObj } from '@storybook/react-vite';
import { FolderOpen } from 'lucide-react';
import {
  Button,
  EmptyState,
  InlineFeedback,
  LoadingState,
  Status,
  ToastProvider,
  useToast,
} from './components';

const meta = {
  title: 'Feedback/States',
  component: Status,
  args: {
    tone: 'success',
    children: '已完成',
  },
  parameters: {
    docs: {
      description: {
        component:
          '状态通过图标、文字与结构共同表达，不能只依赖颜色。成功、警告、错误和信息具有独立前景/背景 token。',
      },
    },
  },
} satisfies Meta<typeof Status>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SemanticStatuses: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
      <Status tone="success">已生成</Status>
      <Status tone="warning">需要检查</Status>
      <Status tone="error">执行失败</Status>
      <Status tone="info">等待输入</Status>
      <Status tone="success" pill>已加入资源</Status>
    </div>
  ),
};

export const FailureRecovery: Story = {
  render: () => (
    <InlineFeedback
      tone="error"
      title="预览加载失败"
      action={<Button size="compact">重试</Button>}
    >
      <p>参数和上一版结果已保留，可重新尝试。</p>
    </InlineFeedback>
  ),
};

export const EmptyAndLoading: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
      <EmptyState
        icon={<FolderOpen className="fx-icon" />}
        title="还没有角色资源"
        description="先生成一个角色，结果确认后再加入项目资源。"
        action={<Button variant="primary">生成角色</Button>}
      />
      <LoadingState title="正在生成角色" description="保留当前参数；需要时可以取消。" />
    </div>
  ),
};

function ToastDemo() {
  const { notify } = useToast();
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Button onClick={() => notify({ tone: 'success', title: '已生成', description: '尚未加入资源。' })}>
        成功通知
      </Button>
      <Button onClick={() => notify({ tone: 'error', title: '导出失败', description: '资源保持不变，请重试。' })}>
        短暂失败通知
      </Button>
      <Button
        onClick={() =>
          notify({
            tone: 'error',
            persistent: true,
            title: '命令失败',
            description: '不会自动关闭，需要点击关闭。',
          })
        }
      >
        持久失败通知
      </Button>
    </div>
  );
}

export const ToastNotifications: Story = {
  render: () => (
    <ToastProvider>
      <ToastDemo />
    </ToastProvider>
  ),
};

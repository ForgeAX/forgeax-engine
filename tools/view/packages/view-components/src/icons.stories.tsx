import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  ArrowUp,
  Box,
  Check,
  ChevronRight,
  Copy,
  Download,
  File,
  Folder,
  Grid3X3,
  Image,
  Info,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Icon, Text } from './components';
import { SpecSection, TokenValue, specimenGrid } from './storybook/Specimens';

const meta = {
  title: 'Controls/Icon',
  component: Icon,
  args: {
    icon: Box,
  },
  parameters: {
    docs: {
      description: {
        component:
          '统一使用 16px、1.5 描边的 Lucide 轮廓图标。无文字图标按钮必须提供可访问名称，最小命中区域为 24×24px。',
      },
    },
  },
  argTypes: {
    icon: { control: false },
  },
} satisfies Meta<typeof Icon>;

export default meta;
type Story = StoryObj<typeof meta>;

const icons = [
  ['模型', Box],
  ['上传', ArrowUp],
  ['完成', Check],
  ['关闭', X],
  ['复制', Copy],
  ['导出', Download],
  ['搜索', Search],
  ['资源', Folder],
  ['网格', Grid3X3],
  ['对话', MessageSquare],
  ['设置', Settings],
  ['图片', Image],
  ['播放', Play],
  ['暂停', Pause],
  ['重置', RotateCcw],
  ['最大化', Maximize2],
  ['添加', Plus],
  ['更多', MoreHorizontal],
  ['展开', ChevronRight],
  ['信息', Info],
  ['警告', TriangleAlert],
  ['文件', File],
  ['生成', Sparkles],
] as const;

export const Gallery: Story = {
  name: '规范图标集',
  render: () => (
    <SpecSection title="图标">
      <div style={specimenGrid}>
        {icons.map(([label, glyph]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
            <Icon icon={glyph} />
            <Text>{label}</Text>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <TokenValue token="--fx-component-control-icon-size" />
        <TokenValue token="--fx-component-control-icon-hit-area-min" />
      </div>
    </SpecSection>
  ),
};

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Box, Paperclip, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  Composer,
  Conversation,
  Field,
  FileRow,
  IconButton,
  InlineFeedback,
  Status,
  Text,
  TextArea,
  TextInput,
  type Message,
} from './components';

const meta = {
  title: 'Workflows/Business Closure',
  parameters: {
    docs: {
      description: {
        component:
          '业务闭环 Stories 组合真实公共组件，明确区分“已生成、已加入资源、已应用到场景”，并验证失败时保留参数和上一版结果。',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

type GenerationState = 'configure' | 'generating' | 'generated' | 'added' | 'applied' | 'failed';

function CharacterWorkflow() {
  const [state, setState] = useState<GenerationState>('configure');
  const [name, setName] = useState('林地狐狸');
  const [description, setDescription] = useState('低多边形森林向导，包含骨骼和待机动作。');
  const generated = ['generated', 'added', 'applied', 'failed'].includes(state);

  const status =
    state === 'generated'
      ? '已生成 · 尚未加入资源'
      : state === 'added'
        ? '已加入资源 · 尚未应用到场景'
        : state === 'applied'
          ? '已应用到场景'
          : '上一版结果已保留';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 320px) minmax(340px, 1fr)', gap: 24 }}>
      <section style={{ display: 'grid', gap: 16 }}>
        <Text as="h2" variant="heading">角色配置</Text>
        <Field label="角色名称" htmlFor="workflow-name">
          <TextInput id="workflow-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="角色描述" htmlFor="workflow-description" note="失败或重试不会清空这些参数。">
          <TextArea
            id="workflow-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Button
          variant="primary"
          loading={state === 'generating'}
          onClick={() => setState('generating')}
        >
          {state === 'generating' ? '正在生成' : '生成角色'}
        </Button>
        {state === 'generating' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="compact" onClick={() => setState('generated')}>模拟生成成功</Button>
            <Button size="compact" variant="quiet" onClick={() => setState('failed')}>模拟失败</Button>
          </div>
        )}
      </section>

      <section style={{ display: 'grid', alignContent: 'start', gap: 16 }}>
        <Text as="h2" variant="heading">当前结果</Text>
        {!generated && state !== 'generating' && (
          <Text tone="secondary">填写配置后生成角色。结果确认后再加入项目资源。</Text>
        )}
        {state === 'generating' && <Status tone="info">正在生成；输入参数保持可见</Status>}
        {state === 'failed' && (
          <InlineFeedback
            tone="error"
            title="预览加载失败"
            action={
              <Button size="compact" leadingIcon={<RotateCcw className="fx-icon" />} onClick={() => setState('generating')}>
                重试
              </Button>
            }
          >
            <p>参数和上一版结果已保留，可重新尝试。</p>
          </InlineFeedback>
        )}
        {generated && (
          <FileRow
            icon={<Box className="fx-icon" />}
            name={`${name || '未命名角色'}.glb`}
            status={status}
            action={
              state === 'generated' ? (
                <Button size="compact" onClick={() => setState('added')}>加入资源</Button>
              ) : state === 'added' ? (
                <Button size="compact" variant="primary" onClick={() => setState('applied')}>应用到场景</Button>
              ) : state === 'applied' ? (
                <Status tone="success">已应用</Status>
              ) : null
            }
          />
        )}
      </section>
    </div>
  );
}

export const CharacterGenerationLifecycle: Story = {
  render: () => <CharacterWorkflow />,
};

function ConversationWorkflow() {
  const [value, setValue] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', role: 'assistant', content: '请选择资源或描述你希望执行的操作。' },
  ]);
  return (
    <div style={{ width: 'min(100%, 720px)', margin: '0 auto' }}>
      <Conversation messages={messages} />
      <Composer
        value={value}
        onChange={setValue}
        onSubmit={() => {
          setMessages((current) => [
            ...current,
            { id: String(current.length + 1), role: 'user', content: value },
          ]);
          setValue('');
        }}
        tools={
          <IconButton
            label="引用资源"
            icon={<Paperclip className="fx-icon" />}
            variant="quiet"
            size="compact"
          />
        }
      />
    </div>
  );
}

export const ConversationAndComposer: Story = {
  render: () => <ConversationWorkflow />,
};

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Box, Folder, Image, Settings, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  CollapsibleSection,
  ConfigPreviewLayout,
  FileRow,
  IconButton,
  NavigationRail,
  PanelHeader,
  PropertyRow,
  SearchField,
  Select,
  Text,
  TextInput,
  Toolbar,
} from './components';
import { InspectorForm } from './InspectorForm';
import { AssetReferenceField } from './AssetReferenceField';
import { ClipboardProvider } from './clipboard';

const meta = {
  title: 'Editor Patterns/Panel and Layout',
  component: PanelHeader,
  parameters: {
    docs: {
      description: {
        component:
          '编辑器模式由受控公共组件组成：面板标题、工具栏、搜索、折叠属性区、导航轨和“左配置 + 主预览”布局。组件不拥有 Engine 或插件业务状态。',
      },
    },
  },
} satisfies Meta<typeof PanelHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PanelChrome: Story = {
  render: () => (
    <div style={{ border: '1px solid var(--fx-color-border-default)' }}>
      <PanelHeader
        start={<Text as="strong" variant="label">资源</Text>}
        center={<SearchField placeholder="搜索资源" style={{ width: 240 }} />}
        end={
          <Toolbar>
            <IconButton label="筛选" icon={<SlidersHorizontal className="fx-icon" />} size="compact" />
            <IconButton label="设置" icon={<Settings className="fx-icon" />} size="compact" />
          </Toolbar>
        }
      />
      <FileRow
        icon={<Box className="fx-icon" />}
        name="林地狐狸.glb"
        status="已生成 · 尚未加入资源"
        action={<Button size="compact">查看资源</Button>}
      />
    </div>
  ),
};

export const InspectorSections: Story = {
  parameters: { docs: { description: { story: 'Trailing controls are siblings of the disclosure button. They remain keyboard accessible and do not toggle the section.' } } },
  render: () => (
    <div style={{ width: 360, border: '1px solid var(--fx-color-border-default)' }}>
      <CollapsibleSection title="Transform" trailing={<Button size="compact" onClick={() => navigator.clipboard?.writeText("Transform")}>Copy</Button>}>
        <PropertyRow label="位置 X"><TextInput type="number" defaultValue="1.00" /></PropertyRow>
        <PropertyRow label="位置 Y"><TextInput type="number" defaultValue="0.00" /></PropertyRow>
        <PropertyRow label="可见性">
          <Select defaultValue="visible">
            <option value="visible">可见</option>
            <option value="hidden">隐藏</option>
          </Select>
        </PropertyRow>
      </CollapsibleSection>
      <CollapsibleSection title="材质" defaultOpen={false}>
        <PropertyRow label="资源"><TextInput defaultValue="Fox_Fur.mat" /></PropertyRow>
      </CollapsibleSection>
    </div>
  ),
};

export const ReadOnlyInspectorForm: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Read-only inspector fields cover XYZ angles, vectors, checkboxes, switches, choices, colors, and asset references. Omitted edit callbacks disable Clear and Reveal; omitted asset labels use the defaults.',
      },
    },
  },
  render: () => (
    <div style={{ width: 360, height: 520, border: '1px solid var(--fx-color-border-default)' }}>
      <InspectorForm
        groups={[
          {
            key: 'identity',
            name: 'Texture Facts',
            category: 'type',
            fields: [
              { key: 'guid', label: 'GUID', kind: 'text', value: 'tex-grass' },
              { key: 'mipLevels', label: 'Mip Levels', kind: 'number', value: 8 },
              { key: 'alpha', label: 'Alpha', kind: 'bool', value: true },
              { key: 'streaming', label: 'Streaming', kind: 'switch', value: false },
              { key: 'albedo', label: 'Albedo', kind: 'color', value: '#91a874' },
            ],
          },
          {
            key: 'transform',
            name: 'Import Settings',
            category: 'all',
            fields: [
              { key: 'offset', label: 'Offset', kind: 'vector3', value: { x: -1.2, y: 0, z: -4.5 } },
              { key: 'quat', label: 'Rotation', kind: 'angle3', value: { x: 30, y: 45, z: -60 } },
              { key: 'rotationRaw', label: 'Raw Rotation', kind: 'vector4', value: { x: 0, y: 0, z: 0, w: 1 } },
              { key: 'filter', label: 'Filter', kind: 'enum', value: 'Linear', options: ['Point', 'Linear'] },
            ],
          },
          {
            key: 'slots',
            name: 'Material Slots',
            category: 'capability',
            fields: [],
            groups: [
              {
                key: 'slots.0',
                name: 'Surface',
                category: 'type',
                fields: [
                  { key: 'defaultMaterial', label: 'Default Material', kind: 'asset', value: { guid: 'material-grass', name: 'Grass', kind: 'material' } },
                  { key: 'overrideMaterial', label: 'Override', kind: 'asset', value: '' },
                  { key: 'missingMaterial', label: 'Missing', kind: 'asset', value: { guid: 'material-removed', missing: true } },
                ],
              },
            ],
          },
        ]}
      />
    </div>
  ),
};

function NavigableAssetFields() {
  const [action, setAction] = useState('');
  return <div style={{ width: 380 }}><InspectorForm groups={[{ key: 'references', name: 'Asset References', fields: [
    { key: 'material', label: 'Material', kind: 'asset', value: { guid: 'surface', name: 'Surface', kind: 'material' } },
    { key: 'missing', label: 'Missing', kind: 'asset', value: { guid: 'missing', name: 'Missing', missing: true } },
    { key: 'unregistered', label: 'Unregistered', kind: 'asset', value: { name: 'World handle 1028', kind: 'mesh' } },
    { key: 'unavailable', label: 'Unavailable viewer', kind: 'asset', value: { guid: 'unavailable', name: 'Unavailable', kind: 'mesh' } },
  ] }]} assetActions={value => value && typeof value === 'object' && 'guid' in value && value.guid === 'surface'
    ? { onOpen: () => setAction('Opened Surface'), onBrowse: () => setAction('Located Surface') } : undefined} />
    <output aria-live="polite">{action}</output></div>;
}
export const InspectorAssetNavigation: Story = {
  parameters: { docs: { description: { story: 'Asset names are read-only and never navigate. Separate folder and external-link buttons locate the asset or open its viewer. Existing unsupported controls remain visible but disabled. Missing identities and unavailable viewers explain their disabled open action in a tooltip.' } } },
  render: () => <NavigableAssetFields />,
};

function LayoutExample() {
  const [active, setActive] = useState('model');
  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        maxWidth: 960,
        height: 520,
        border: '1px solid var(--fx-color-border-default)',
      }}
    >
      <NavigationRail
        activeId={active}
        onSelect={setActive}
        items={[
          { id: 'model', label: '模型', icon: <Box className="fx-icon" /> },
          { id: 'assets', label: '资源', icon: <Folder className="fx-icon" /> },
          { id: 'images', label: '图片', icon: <Image className="fx-icon" /> },
        ]}
      />
      <ConfigPreviewLayout
        className="fx-ui"
        config={
          <div style={{ display: 'grid', gap: 16 }}>
            <Text as="h2" variant="heading">配置</Text>
            <PropertyRow label="名称"><TextInput defaultValue="林地狐狸" /></PropertyRow>
            <PropertyRow label="质量">
              <Select defaultValue="standard"><option value="standard">标准</option></Select>
            </PropertyRow>
          </div>
        }
        action={<Button variant="primary" style={{ width: '100%' }}>生成角色</Button>}
        preview={
          <div className="fx-config-preview__preview-stage">
            <Box size={64} strokeWidth={1} />
            <Text variant="heading">主预览</Text>
            <Text tone="secondary">模型、动作与当前结果</Text>
          </div>
        }
      />
    </div>
  );
}

export const ConfigAndPreviewLayout: Story = {
  render: () => <LayoutExample />,
};

function ClipboardAssetReference({ denied = false }: { denied?: boolean }) {
  const [copied, setCopied] = useState('');
  return <div style={{ width: 360, padding: 16 }}>
    <ClipboardProvider writeText={async text => {
      if (denied) throw new Error('Platform clipboard permission denied');
      setCopied(text);
    }}>
      <AssetReferenceField value={{ guid: 'material-grass', name: 'Grass', kind: 'material' }} />
      <Text as="output" aria-live="polite">{copied ? `Copied: ${copied}` : 'Choose More reference actions, then Copy GUID.'}</Text>
    </ClipboardProvider>
  </div>;
}

export const AssetReferenceClipboard: Story = {
  parameters: { docs: { description: { story: 'Copy GUID uses the injected platform clipboard capability. This example displays the accepted value without writing the system clipboard.' } } },
  render: () => <ClipboardAssetReference />,
};

export const AssetReferenceClipboardDenied: Story = {
  parameters: { docs: { description: { story: 'A denied platform clipboard write remains visible and can be dismissed.' } } },
  render: () => <ClipboardAssetReference denied />,
};

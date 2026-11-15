import { referenceCloudCookers } from '@forgeax-assets/volumetric-clouds/build';
import type {} from '@forgeax/engine/devkit/plugin-build';
import type { Plugin } from '@forgeax/engine/plugin';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine/render';

export const build: Plugin = {
  name: 'vc-ue5/build',
  provide: 'devkitAppOptions',
  inject: ['nativeCookers'],
  apply(ctx) {
    ctx.provide('devkitAppOptions', {
      standardProfile: DEFAULT_STANDARD_PROFILE,
      loadingLabels: {
        lang: 'zh-CN',
        phases: {
          'engine-code': '正在下载引擎代码',
          workers: '正在启动工作线程',
          downloads: '正在下载资产',
          assets: '正在加载资产',
          pipelines: '正在准备着色器与管线',
          scene: '正在构建场景',
          'first-frame': '正在等待首帧',
        },
        loading: '正在加载…',
        elapsed: '{seconds} 秒',
        slow: '仍在加载，可继续等待或重新加载。',
        reload: '重新加载',
        host: {
          game: '演示',
          engine: '引擎',
          completedFramesPerSecond: '每秒实际完成帧数',
          startupFailed: '无法启动演示。',
          runtimeFailed: '演示因运行错误而停止。',
          startupFailureTitle: 'ForgeAX 演示启动失败。',
          runtimeFailureTitle: 'ForgeAX 演示已停止。',
          diagnostics: '诊断信息',
          copyDiagnostics: '复制诊断信息',
          diagnosticsCopied: '诊断信息已复制。',
          diagnosticsCopyFailed: '无法复制诊断信息。',
          javascriptRequired: '此演示需要 JavaScript，请启用后重新加载。',
          rendererDiagnosis: '渲染诊断：ForgeAX 支持浏览器 WebGPU 和 wgpu/WebGL2 后备方式。此错误本身不能说明 WebGPU 不受支持，请查看上方的错误代码、提示和底层原因。',
          cacheRefreshing: '正在刷新启动缓存，并重试一次…',
          cacheRetried: '已尝试一次自动启动缓存恢复。',
          firstFailure: '首次错误：',
          cacheRecoveryFailed: '启动缓存恢复失败：',
          unknownStructuredFailure: '未知的结构化启动错误',
          unserializableStructuredFailure: '无法序列化的结构化启动错误',
          unknownStartupFailure: '未知启动错误',
          diagnosticNodeLimit: '[诊断节点已达上限]',
          circularDiagnostic: '[循环引用]',
        },
      },
    });
    const registry = ctx.nativeCookers;
    if (!registry) throw new Error('The build host must provide its NativeCooker registry.');
    for (const cooker of referenceCloudCookers()) ctx.effect(() => registry.register(cooker));
  },
};

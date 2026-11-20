<!-- LANG-SWITCH -->
**Language**: [English](README.md) · **简体中文**

# Textures (LearnOpenGL §1.4)

> [!NOTE]
> **对应 LO 原章节**：[LearnOpenGL §1.4 Textures](https://learnopengl.com/Getting-started/Textures)
>
> **对应引擎能力**：feat-20260515-learn-render-getting-started — `@forgeax/engine-image` 解码 + `forgeax asset import` 产 sidecar + GUID 寻址的 `assets.load(guid, 'texture')`；Renderer 自动消费材质的 `values.baseColorTexture` 槽位。

## 这个示例展示什么

LO §1.4 展示磁盘图片如何成为材质采样输入。这个示例用 Catalog 加载纹理，在运行时创建 cube 和材质，然后将资产句柄绑定到 ECS 实体。

1. `forgeax asset import` 维护图片 sidecar 中的 GUID 和导入设置。
2. `assets.load(textureGuid, 'texture')` 返回受管理的纹理句柄。
3. `assets.create(mesh)` 和 `assets.create(material)` 创建本例几何与材质；材质的 `values.baseColorTexture` 引用纹理。
4. `MeshFilter.assetHandle` 和 `MeshRenderer.materials` 引用这些句柄。Renderer 负责资源上传、绑定和后续资产更新。

## 渲染流程

```mermaid
flowchart LR
  Disk["assets/wood-container.jpg<br/>+ .meta.json"] --> Imp["forgeax asset import"]
  Imp --> Sidecar["GUID 写入 sidecar<br/>(UUIDv7)"]
  Sidecar --> RT["assets.load(guid, 'texture')"]
  RT --> Reg["AssetRegistry"]
  Reg --> Up["uploadTexture<br/>(rgba8unorm-srgb)"]
  Up --> Mat["UnlitMaterialAsset<br/>baseColorTexture"]
  Mat --> Spawn["world.spawn<br/>MeshRenderer"]
  Spawn --> RS["RenderSystem extract<br/>materialBindGroup"]
  RS --> Pipe["unlit.wgsl + sampler2D"]
  Pipe --> Frame["swap-chain frame"]
```

## 引擎用法

资产调用摘自 [src/index.ts](src/index.ts) 的启动流程；`assets` 和 `world` 来自已经创建的 App，`textureGuid` 是已校验的纹理 GUID，`materialEntry.payload` 是示例 Pack 中的材质声明。

```ts
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

configureRuntimeAssetCatalog(assets, runtimeBinding);
const texture = (await assets.load(textureGuid, 'texture')).unwrap();
const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
const material = assets.create({
  ...materialEntry.payload,
  values: { ...materialEntry.payload.values, baseColorTexture: texture },
}).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: cube } },
  { component: MeshRenderer, data: { materials: [material] } },
).unwrap();
```

纹理通过 Catalog 的 GUID 加载；几何与材质直接由 `assets.create` 建立运行时身份。相机和 Update 系统保持在示例自己的 ECS 装配中，最后由 `app.start()` 驱动帧循环。运行时修改材质使用 `assets.update(material, { values: { baseColor: [1, 0.5, 0.2, 1] } }).unwrap()`，版本和渲染更新由资产 owner 维护。

## 与 LO 原版的差异

| 维度 | LO 原版（C++ / GLSL 330） | forgeax 这里（TS / WGSL） |
|:--|:--|:--|
| 解码 | `stb_image.h` 的 `stbi_load("container.jpg", &w, &h, &nrChannels, 0)`，单线程同步读 + 解码 | build-time `@forgeax/engine-image` 在 `forgeax asset import` 流水线里调用解码 → 写 sidecar；runtime 完全隔离解码（charter P5 + research F-4） |
| GPU 上传 | `glGenTextures(1, &id) + glBindTexture(GL_TEXTURE_2D, id) + glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, w, h, 0, GL_RGB, GL_UNSIGNED_BYTE, data)` 串行手写状态机 | `assets.load(woodGuid, 'texture')` 单入口 → 引擎内部 `uploadTexture` + 自动绑定到 `materialBindGroup` 槽位（`render-system-extract.ts` 的 switch `mat.shadingModel`） |
| 采样器配置 | `glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT)` + `GL_TEXTURE_MIN_FILTER, GL_LINEAR` 等四五行 GL 调用 | `importSettings: { colorSpace, mipmap, addressMode, filterMode }` 一次性写入 sidecar；reimport byte-identical（AC-16） |
| 颜色空间 | `glTexImage2D(internalformat=GL_SRGB)` 手指定 + 教程末提示注意线性空间 | `TextureAsset.format: 'rgba8unorm-srgb' \| 'rgba8unorm'` + `colorSpace: 'srgb' \| 'linear'`；`linear + srgb` 组合在 dawn 测试里抛 `image-format-unsupported.detail.formatColorSpaceConflict`（AC-08） |
| Shader 采样 | `texture(ourTexture, TexCoord)` GLSL `sampler2D` uniform；CPU 侧 `glUniform1i(loc, 0)` 手绑 unit 0 | WGSL `@group(?) @binding(?) var sampler_0: sampler` + `var texture_0: texture_2d<f32>` 由引擎自动布局；AI 用户不写 binding number |
| 错误处理 | `if (data) { ... glTexImage2D(...); stbi_image_free(data); } else { std::cout << "Failed to load texture" << std::endl; }` 字符串打印；可静默继续 | forgeax 用结构化错误（`err.code` 闭族 `AssetErrorCode 4` + `PackErrorCode 8` + image-format-unsupported / image-meta-missing）替代 LO C++ 抛异常 / 静默失败；AI 用户 `switch (err.code)` exhaustive narrow，不解析 `err.message`（charter P3） |
| 路径加载 | `stbi_load("container.jpg", ...)` 直接物理路径 | runtime 不接受路径；GUID 是唯一寻址凭证；pack-index.json 4 字段（`guid` / `packageUrl` / `kind` / `sourcePath`）由 `vite-plugin-pack` 在 build/dev 阶段维护 |
| Mesh 顶点 | `glVertexAttribPointer(0, 3, GL_FLOAT, ...) + glEnableVertexAttribArray(0)` + `glVertexAttribPointer(1, 2, GL_FLOAT, ...)` 手布局 pos + uv | `MeshFilter { assetHandle: cubeHandleRes.value }`（由资产 owner 管理的几何句柄）；引擎自动绑定 `@location(0) pos` + `@location(1) uv` |

## 关键代码量

| 文件 | 行数 | 角色 |
|:--|---:|:--|
| `src/index.ts` | ~390 | 三段式注释（引擎使用 + 示例胶水 + 启动）+ 4 步 recipe + `// ac-09:` 锚点 + `__captureTextures` 钩子 |
| `assets/wood-container.meta.json` | ~30 | `kind=external-asset-package` sidecar（subAssets[0]={kind,sourceIndex,guid} + importSettings 5 字段） |
| `assets/material-wood.pack.json` | ~25 | `kind=internal-text-package`（UnlitMaterialAsset payload + baseColorTexture refs[0]） |
| `src/__tests__/textures.browser.test.ts` | ~150 | vitest browser e2e（AC-08 + AC-09 + AC-13 + AC-15 (c) + AC-17 (a) 三段断言） |
| `src/__tests__/textures-srgb.dawn.test.ts` | ~110 | dawn-node sRGB / linear 一致性反例（AC-08 image-format-unsupported.detail.formatColorSpaceConflict） |
| `scripts/smoke-dawn.mjs` | ~330 | dawn-node 端到端：解码 → 上传 → 60 帧 → 5-pixel grid readback + AC-25 wall-time 监控 |

## HMR 手动验证

`@forgeax/engine-vite-plugin-pack` 的 `configureServer` 中间件观察资产目录树中的五类文件后缀（`.meta.json`、`.pack.json`、`.jpg`、`.jpeg`、`.png`），并发布中性的 Catalog 变化。本应用在 `vite.config.ts` 显式选择 `refresh: reloadAssetHost()`，因此观察到变更后由宿主请求 Vite `full-reload`。这项源文件刷新策略独立于运行时资产编辑：已接纳的 `assets.update`、`assets.writeRange` 通过资产所有者发布变化，不重载 App。

| 触发条件 | 文件 | 预期观察 |
|:--|:--|:--|
| （1）伴随元数据的 `importSettings` 改变 | `assets/wood-container.meta.json`（如在 `mipmap: "auto"` 与 `mipmap: "none"` 之间切换） | 插件重建目录，浏览器重载，立方体显示新的采样器或 Mip 状态。 |
| （2）pack-index 间接变化 | 重命名或删除 `.pack.json`、`.meta.json` 条目 | 插件重建目录，浏览器重载，`assets.load` 按变更 GUID 解析新载荷。 |
| （3）JPG 内容变化 | `assets/wood-container.jpg`（如用 ImageMagick 重新导出到原路径） | 目录行来自伴随元数据，不随图片字节改变；本应用显式宿主刷新会重载浏览器，随后立方体显示新像素。 |

手动执行：

```bash
pnpm --filter "@forgeax/app-learn-render-1-getting-started-4-textures" dev
# In another terminal, edit one of the three trigger paths above; observe
# the `[forgeax-pack] ... changed: <filename>` warn line on stderr and the
# vite [vite] hmr update log on stdout. Confirm the canvas redraws with
# the new asset state after the reload completes.
```

失败处理：开发插件不会因 schema 错误阻塞迭代；格式错误的伴随文件会被跳过，并在控制台输出 `[forgeax-pack] scan error` 警告。schema 的严格校验由 `forgeax asset verify --root <project> --json` 执行（八步快速失败扫描）；开发路径优先保证迭代节奏。

## 运行

```bash
# 开发服务器（vite 端口 5183）
pnpm --filter "@forgeax/app-learn-render-1-getting-started-4-textures" dev

# 构建（产出 dist/）
pnpm --filter "@forgeax/app-learn-render-1-getting-started-4-textures" build

# vitest browser e2e（chromium + WebGPU）
pnpm test:browser

# vitest dawn e2e（sRGB / linear 一致性）
pnpm test:dawn

# dawn-node smoke (60 frames + pixel readback epsilon <= 0.05)
pnpm --filter "@forgeax/app-learn-render-1-getting-started-4-textures" smoke

# 录制 golden PNG（forgeax-engine-assets 子模块）
pnpm --filter "@forgeax/app-learn-render-1-getting-started-4-textures" exec node scripts/bench-screenshot.mjs

# Build-time importer（产 sidecar；reimport byte-identical AC-16）
pnpm exec forgeax asset import \
  apps/learn-render/1.getting-started/4.textures/assets/wood-container.jpg
pnpm exec forgeax asset verify \
  apps/learn-render/1.getting-started/4.textures/assets/
```

<details>
<summary>LO 原版 C++/GLSL 关键片段（参考用）</summary>

LO §1.4 在 `src/1.getting_started/4.1.textures/textures.cpp` + `4.1.texture.fs` / `4.1.texture.vs` 的核心代码（来自 [JoeyDeVries/LearnOpenGL master 分支](https://github.com/JoeyDeVries/LearnOpenGL)）：

```glsl
// 4.1.texture.vs (vertex shader, GLSL 330)
#version 330 core
layout (location = 0) in vec3 aPos;
layout (location = 1) in vec3 aColor;
layout (location = 2) in vec2 aTexCoord;

out vec3 ourColor;
out vec2 TexCoord;

void main()
{
    gl_Position = vec4(aPos, 1.0);
    ourColor = aColor;
    TexCoord = vec2(aTexCoord.x, aTexCoord.y);
}
```

```glsl
// 4.1.texture.fs (fragment shader, GLSL 330)
#version 330 core
out vec4 FragColor;

in vec3 ourColor;
in vec2 TexCoord;

uniform sampler2D ourTexture;

void main()
{
    FragColor = texture(ourTexture, TexCoord);
}
```

```cpp
// textures.cpp -- stb_image load + glTexImage2D upload + sampler config
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

// load and create a texture
unsigned int texture;
glGenTextures(1, &texture);
glBindTexture(GL_TEXTURE_2D, texture);

// set the texture wrapping parameters
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
// set texture filtering parameters
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

// load image, create texture and generate mipmaps
int width, height, nrChannels;
unsigned char *data = stbi_load("resources/textures/container.jpg", &width, &height, &nrChannels, 0);
if (data)
{
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, width, height, 0, GL_RGB, GL_UNSIGNED_BYTE, data);
    glGenerateMipmap(GL_TEXTURE_2D);
}
else
{
    std::cout << "Failed to load texture" << std::endl;
}
stbi_image_free(data);

while (!glfwWindowShouldClose(window))
{
    // bind Texture
    glBindTexture(GL_TEXTURE_2D, texture);

    // render container
    glUseProgram(shaderProgram);
    glBindVertexArray(VAO);
    glDrawArrays(GL_TRIANGLES, 0, 6);

    glfwSwapBuffers(window);
    glfwPollEvents();
}
```

`stb_image.h` / `stbi_load` / `glGenTextures` / `glBindTexture` / `glTexImage2D` / `glTexParameteri` / `glGenerateMipmap` / `texture(sampler2D, ...)` / `void main` / `gl_Position` 十个 LO §1.4 关键标识在本折叠块全部命中（grep 闸门 AC-23 + T-M8-05 description）。

</details>

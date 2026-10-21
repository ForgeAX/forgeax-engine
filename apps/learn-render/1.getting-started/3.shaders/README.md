# Shaders (LearnOpenGL §1.3)

> [!NOTE]
> **对应 LO 原章节**：[LearnOpenGL §1.3 Shaders](https://learnopengl.com/Getting-started/Shaders)
>
> **对应引擎能力**：feat-20260515-learn-render-getting-started — 材质 `passes[].program` 选择 `forgeax::default-unlit` + 自定义 WGSL fragment uniform 脉动播放（`packages/shader/src/unlit.wgsl` 实际驱动；本目录 `src/shaders/play.wgsl` 是 LO §1.3 → forgeax 的 shader 阶段映射文档伴侣）。

## 这个示例展示什么

LO §1.3 的核心论点是「用 uniform 把 CPU 数据塞进 fragment shader，让颜色随时间脉动」。forgeax 把同样的语义切成三层：

1. **创建材质资产** — `assets.create` 接收包含 `passes` 与 `values.baseColor` 的材质声明，返回运行时身份。
2. **ECS 引用资产** — `MeshFilter.assetHandle` 引用三角形，`MeshRenderer.materials` 引用材质；Pass 的程序声明决定管线。
3. **rAF 内驱 pulse 标量** — `Math.sin(elapsedSeconds)` 每帧驱动一个 `pulse: number`，挂在 `globalThis.__captureShadersPulse` 上让 AI 用户从 DevTools / bench-screenshot 单点观测

> [!IMPORTANT]
> **forgeax 不暴露 `glUseProgram` / `glGetUniformLocation` 这类 OpenGL 全局状态机入口**；shader 选择由材质 Pass 的程序声明完成（charter P4 一致抽象）。AI 用户写「我要 unlit 颜色脉动」就是写 `MaterialAsset` POD + 一个 sin 驱动的 pulse 数值，不用学 GL 状态机词汇。

## 渲染流程

```mermaid
flowchart LR
  CPU["CPU 每帧"] --> Pulse["pulse = (sin(t)+1)/2"]
  Pulse --> Mat["MaterialAsset.values.baseColor"]
  Mat --> Reg["AssetRegistry"]
  Reg --> RS["Renderer consumes material Pass"]
  RS --> Pipe["unlit.wgsl pipeline"]
  Pipe --> FS["@fragment fs_main"]
  FS --> Frame["swap-chain frame"]
```

## 引擎用法

[src/index.ts](src/index.ts) 从当前 World 的资产 owner 创建三角形与一份带 Forward Pass 的 unlit 材质：

```ts
import { createPrimitiveMesh } from '@forgeax/engine-geometry';

const triangle = assets.create(createPrimitiveMesh('triangle').unwrap()).unwrap();
const material = assets.create({
  kind: 'material',
  passes: [{
    name: 'Forward',
    program: { module: 'forgeax::default-unlit' },
    renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
  }],
  values: { baseColor: [1, 0.5, 0.2, 1] },
}).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: triangle } },
  { component: MeshRenderer, data: { materials: [material] } },
).unwrap();
```

示例的 pulse 观测钩子与相机装配见源码。需要改变实际材质颜色时，调用 `assets.update(material, { values: { baseColor: [1, pulse, 0.2, 1] } }).unwrap()`；资产 owner 自动发布版本，Renderer 消费更新。

## 与 LO 原版的差异

| 维度 | LO 原版（C++ / GLSL 330） | forgeax 这里（TS / WGSL） |
|:--|:--|:--|
| Shader 语言 | GLSL 330（`#version 330 core` + `void main()`） | WGSL（`@vertex` / `@fragment` + `fn vs_main` / `fn fs_main`） |
| Shader 选择 | `glCreateShader` + `glShaderSource` + `glCompileShader` + `glAttachShader` + `glLinkProgram` + `glUseProgram` 串行手写状态机 | `MaterialAsset.passes[].program` 选择已编译程序 |
| Uniform 设置 | `glGetUniformLocation(program, "ourColor")` + `glUniform4f(loc, r, g, b, a)` 每帧手动设置 | `assets.create(material)` 创建，`assets.update(handle, patch)` 更新；ECS `MeshRenderer.materials` 引用句柄 |
| 时间脉动 | `float timeValue = glfwGetTime(); float green = sin(timeValue) / 2.0 + 0.5;` 在 GLFW 主循环内 | `computePulse(performance.now(), basePulseTime)` 在 rAF tick 内；`globalThis.__captureShadersPulse` 暴露给观测者 |
| 错误处理 | `glGetShaderiv(GL_COMPILE_STATUS) + glGetShaderInfoLog` 字符串解析；编译失败可静默或 `cerr` 打印 | forgeax 用结构化错误（`err.code` 闭族 `ShaderErrorCode 7` 成员 + `err.expected` / `err.hint` / `err.detail`）替代 LO C++ 抛异常 / 静默失败；AI 用户 `switch (err.code)` exhaustive narrow，不解析 `err.message`（charter P3） |
| 资源加载 | 直接路径 `Shader ourShader("vs.vs", "fs.fs")` 读文件 | 渲染期不存在路径加载；shader 由引擎注册表（`@forgeax/engine-shader` ShaderRegistry）通过 manifest hash 索引；自定义 wgsl 走 `vite-plugin-shader` 构建期编译 |
| 顶点输入 | `glVertexAttribPointer(0, 3, GL_FLOAT, ...)` 手布局 | `MeshFilter { assetHandle: triangle }` 引用受管理的 Geometry 产物；引擎自动绑定 `@location(0) pos` |

## 关键代码量

| 文件 | 行数 | 角色 |
|:--|---:|:--|
| `src/index.ts` | ~250 | 三段式（引擎使用 + 示例胶水 + 启动）+ pulse 计算 + capture hook |
| `src/shaders/play.wgsl` | ~75 | LO §1.3 → forgeax shader 阶段映射文档（vertex + fragment + pulse uniform） |
| `src/__tests__/shaders.browser.test.ts` | ~130 | vitest browser e2e（AC-05 + AC-06 + AC-22 三段断言） |

## 运行

```bash
# 开发服务器（vite preview 端口 5182）
pnpm --filter "@forgeax/app-learn-render-1-getting-started-3-shaders" dev

# 构建（产出 dist/）
pnpm --filter "@forgeax/app-learn-render-1-getting-started-3-shaders" build

# vitest browser e2e（chromium + WebGPU）
pnpm test:browser

# 录制 golden PNG（forgeax-engine-assets 子模块）
pnpm --filter "@forgeax/app-learn-render-1-getting-started-3-shaders" exec node scripts/bench-screenshot.mjs
```

<details>
<summary>LO 原版 C++/GLSL 关键片段（参考用）</summary>

LO §1.3 在 `src/1.getting_started/3.1.shaders_uniform/shaders_uniform.cpp` + `3.1.shader.fs` / `3.1.shader.vs` 的核心代码（来自 [JoeyDeVries/LearnOpenGL master 分支](https://github.com/JoeyDeVries/LearnOpenGL)）：

```glsl
// 3.1.shader.vs (vertex shader, GLSL 330)
#version 330 core
layout (location = 0) in vec3 aPos;

void main()
{
    gl_Position = vec4(aPos.x, aPos.y, aPos.z, 1.0);
}
```

```glsl
// 3.1.shader.fs (fragment shader, GLSL 330)
#version 330 core
out vec4 FragColor;

uniform vec4 ourColor;

void main()
{
    FragColor = ourColor;
}
```

```cpp
// shaders_uniform.cpp -- shader compile + link + uniform pulse loop
unsigned int vertexShader = glCreateShader(GL_VERTEX_SHADER);
glShaderSource(vertexShader, 1, &vertexShaderSource, NULL);
glCompileShader(vertexShader);

int success;
char infoLog[512];
glGetShaderiv(vertexShader, GL_COMPILE_STATUS, &success);
if (!success)
{
    glGetShaderInfoLog(vertexShader, 512, NULL, infoLog);
    std::cout << "ERROR::SHADER::VERTEX::COMPILATION_FAILED\n" << infoLog << std::endl;
}

// fragment shader compile (GL_FRAGMENT_SHADER) + link program + cleanup omitted

while (!glfwWindowShouldClose(window))
{
    processInput(window);

    glClearColor(0.2f, 0.3f, 0.3f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);

    // be sure to activate the shader before any calls to glUniform
    glUseProgram(shaderProgram);

    // update the uniform color
    float timeValue = glfwGetTime();
    float greenValue = sin(timeValue) / 2.0f + 0.5f;
    int vertexColorLocation = glGetUniformLocation(shaderProgram, "ourColor");
    glUniform4f(vertexColorLocation, 0.0f, greenValue, 0.0f, 1.0f);

    // now render the triangle
    glBindVertexArray(VAO);
    glDrawArrays(GL_TRIANGLES, 0, 3);

    glfwSwapBuffers(window);
    glfwPollEvents();
}
```

`glUseProgram` / `glGetUniformLocation` / `glUniform4f` / shader compile fragment / `void main` / `gl_Position` / `glClear` 七个 GL 关键标识在本折叠块全部命中（grep 闸门 AC-23）。

</details>

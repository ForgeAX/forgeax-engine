**语言**：[English](SKILL.md) · **简体中文**

# 打开 ForgeaX View

使用已安装的 Engine CLI。在游戏根目录运行，或传入游戏的绝对路径。

```sh
forgeax project view --json
forgeax project view --root /absolute/game --json
```

打开返回的 URL，确认所选项目、就绪状态和场景画面。验收游玩时，启动 Play 并检查已完成的一帧。View 页脚显示宿主 Engine 版本。

用响应返回的 backend 根目录执行生命周期命令及[实时 View 操作](../forgeax-view-cli/SKILL.zh-CN.md)。

```sh
forgeax backend status --root /absolute/game --json
forgeax backend stop --root /absolute/game --json
```

保留首次失败的诊断。重试前检查 backend 状态和页面的项目准备详情。分别验证服务就绪和场景画面。交付时给出 URL 和项目。Engine 升级后，已有项目保留项目内的技能副本。刷新前先检查用户对副本的修改。

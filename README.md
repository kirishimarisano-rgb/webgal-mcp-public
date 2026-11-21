# webgal-mcp

用 Codex 和自然语言制作 WebGAL 视觉小说。**Creator** 把故事改编成游戏，**Editor** 修改已有游戏，**Librarian** 帮你从素材库里找背景、立绘和音乐。

## 环境要求

- **制作或编辑游戏**：Windows、Codex CLI、Git、Node.js 24.x 和 WebGAL Terre。已在 **Terre 4.6.7.0** 完成实机验收，其他版本的兼容性待验证。[Terre 验收记录](docs/release-v0.2.0.md)
- **管理素材库**：Librarian 只需 Codex 和 Python 3.10 或更高版本，可以独立使用。

## 快速上手

把下面这段复制给 Codex，即可让它安装三个 Skill：

```text
请从 https://github.com/yuri77521/webgal-mcp-public 安装 webgal-mcp，
并安装 webgal-creator、webgal-editor 和 webgal-librarian 三个 Skill。
请复用已有安装并保留现有配置。帮我以只读方式连接一个 Terre 测试工程，
读出开场第一句，让我确认选对了游戏。
```

如果只想整理素材，可以只让 Codex 安装 `webgal-librarian`。[手动安装](docs/tool-reference.md#手动安装) · [单独安装 Librarian](docs/tool-reference.md#单独安装-librarian)

## 用 Creator Skill 把文章做成短篇

> 请用 $webgal-creator 把这篇文章改成一部短篇视觉小说。先给我看剧本，我确认后再选背景、立绘和音乐。

## 用 Editor 修改已有工程

> 请用 $webgal-editor 把车站场景里，小澪第二次说的「没事」改成「再陪我一下」，并在这句之前播放工程里已有的那首 BGM。

手工制作的 Terre 工程也可以直接修改。Editor 会先展示改动的位置；有多个可能时，会列出前后文让你选。之后也可以说「撤销刚才那次修改」。

**写入游戏前**，先看改动，再保存并关闭该工程的全部 Terre 编辑页。Codex 会重新核对内容，等你单独批准正式计划后才写入。[启用工程写入](docs/tool-reference.md#启用受控写入)

## 用 Librarian 管理共享素材库

> 请用 $webgal-librarian 扫描我的素材文件夹，保持目录原样，只建索引。帮我找一首适合「放学后在车站告别」的 BGM。

[工具参考](docs/tool-reference.md) · [许可证：PolyForm Noncommercial 1.0.0](LICENSE)

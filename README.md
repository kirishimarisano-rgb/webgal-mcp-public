# webgal-mcp

用 Codex 创作和编辑 WebGAL 视觉小说。你可以检查 Terre 工程的素材和场景、修改对白，或把文章改编成可玩的线性短篇。

## 快速上手

**把下面这段话交给 Codex Agent，让它帮你安装。**

```text
请帮我在 Windows 上安装 webgal-mcp 和 webgal-creator。
仓库：https://github.com/yuri77521/webgal-mcp-public

先检查 Git、Node.js 24、Codex CLI 和 WebGAL Terre，能复用的就复用。如果工作区已有这个仓库，请沿用当前版本，否则从上面的地址克隆。构建 MCP，并把 skills/webgal-creator 整个目录安装到我的 Codex Skills 目录。
帮我选择一个 Terre 测试工程，再把它登记到 Codex 的 webgal MCP。如果我还没有工程，请告诉我怎么在 Terre 建一个并保存一句对白。
新配置默认只读，保留我的其他 MCP 配置和工程文件。接通后，用 webgal_status 检查连接和工程映射，再用 scene_read 读开场对白。需要我启动 Terre、选工程或重启 Codex 时，请告诉我具体怎么做。
```

想自己配置，可查看 [Windows 手动安装](docs/tool-reference.md#手动安装)。

## 用 Librarian 管理共享素材库

多个 WebGAL 工程可以共用一个素材文件夹。Librarian 在库根维护 `INDEX.md`，记录背景、立绘、BGM 和音效的相对路径、描述、标签、来源与授权。只需 Codex 和 Python 3.10+ 即可单独使用。[单独安装 Librarian](docs/tool-reference.md#单独安装-librarian)

安装后，在新对话里把示例路径换成你的素材文件夹：

```text
请用 $webgal-librarian 接管「D:\WebGAL素材库」，扫描并建立或更新 INDEX.md，保留素材原档、档名和手动标注。
```

首次接管已有素材的目录时，Librarian 会问你要保留目录，还是先看分类整理方案。选择整理后，你可先核对每个文件的旧路径和新路径，确认后才会移动。日常重扫会保留同一路径的手动标注。

之后可以说「给这首曲子加上『放学后』标签」，或「找适合放学后、安静又有离别感的 BGM」。Librarian 会列出当前可读的候选文件、相对路径和匹配理由，找不到时会说明缺口。

## 用 Creator Skill 把文章做成短篇

装好后，把文章交给 Codex，再发送这句：

```text
请用 $webgal-creator 把这篇文章改编成 WebGAL 短篇，使用我已登记的 Terre 测试工程。先给我 Markdown 剧本，等我确认。
```

确认剧本后，Agent 会列出素材用途和必需或可选项，再跟你确认来源。做好后会抽查指定场景。想让Agent从头到尾试玩一次，可以明确要求「完整验收」。

## 试改一处对白

默认只读。要改游戏，先[开启受控写入](docs/tool-reference.md#启用受控写入)，再让 Agent 给你看改动草案。每批应用前，请在 Terre 保存并关闭该工程的全部编辑页，明确交接，再单独批准正式计划。遇到部分写入或结果不确定时，按[恢复提示](docs/tool-reference.md#连接与试改排查)处理。

[Creator Skill](skills/webgal-creator/) · [工具参考](docs/tool-reference.md) · [Live2D 模型与演出](docs/tool-reference.md#live2d-模型与演出)

源码按 [PolyForm Noncommercial 1.0.0](LICENSE) 提供，限制商业使用。第三方依赖适用各自的许可证。

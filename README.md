# webgal-mcp

**让 Codex 帮你读懂和编辑现有的 WebGAL Terre 游戏。** 你仍在 Terre 里编辑、预览和导出游戏，Codex 可以帮你找场景、检查漏掉的素材，或起草一段对白。

默认**只读**。想让 Codex 修改文件，需要主动开启写入，并在每批修改前先保存、关闭该工程的全部编辑页。

## v0.2.0 可以做什么

v0.2.0 已合入 `main`。按下面的步骤从源码构建即可使用。

- **连接排查。** 用 `webgal_status` 检查工程文件、Terre 连接和工程映射，并按返回的提示处理。
- **导出前检查。** 用 `project_scan` 扫描已保存的场景，定位缺失的素材和跳转目标，并查看需要在 Terre 预览时确认的引用。
- **导入背景图和 BGM。** 开启写入并交接后，可从已登记的本机素材目录导入新文件。单文件最多 16 MiB，流式导入部分每批最多 32 MiB，已有同名文件会保留。

## 用 Codex 编排一段 Live2D 演出

v0.3.0 支持检查和导入标准 `.model3.json` 模型。先按 [WebGAL 的 Live2D 配置说明](https://docs.openwebgal.com/live2D.html) 准备运行库，再使用 Terre 的专用测试工程试用。[模型检查和整包导入示例](docs/tool-reference.md#live2d-模型与演出) 包含素材登记、审阅和交接步骤。已在 Windows、Codex CLI 和 Terre 4.6.7 的专用工程使用官方 Haru 样本验证整包导入、立绘显示、动作播放和表情切换。

模型准备好后，可以把下面这段话交给 Codex，换成实际工程、角色和对白：

```text
请在 my-game 的 start.txt 中找到「你怎么在这里？」这句对白。
用 live2d_model_inspect 查看 hero/hero.model3.json 的动作组与表情名，
从实际存在的选项中挑一个适合惊讶的动作和表情，在这句对白后加一段演出。
保留角色 ID、站位和其他参数。位置、角色或可用动作有歧义时先问我。
用 scene_validate 检查候选文本，再用 change_plan 给我看草案，等我确认。
```

## 快速上手

准备好 **Windows、Node.js 24、Git、Codex CLI** 和正在运行的 [WebGAL Terre](https://github.com/OpenWebGAL/WebGAL_Terre/releases)。请用 Terre 建一个试用工程，给开场加一句对白（例如「你好。」）并保存。下面用 `my-game` 作为工程 ID。

### 1. 下载并构建

在 PowerShell 中运行：

```powershell
git clone https://github.com/yuri77521/webgal-mcp-public.git
cd webgal-mcp-public
npm ci
npm run build
```

### 2. 告诉 webgal-mcp 你的工程在哪

在刚才的目录中新建 `webgal-mcp.local.json`，复制下面的例子，把示例路径改成你自己的。这个文件留在本机。

```json
{
  "version": 1,
  "projects": [
    {
      "id": "my-game",
      "root": "C:/Games/Terre/my-game",
      "terreUrl": "http://127.0.0.1:3001",
      "terreGameDir": "my-game"
    }
  ],
  "sources": []
}
```

- `root` 填**包含 `game/` 的工程目录**，别填到 `game/` 里面。
- `terreGameDir` 填实际文件夹名，而不是 Terre 显示的游戏标题。
- 如果你的 Terre 不用 3001 端口，把 `terreUrl` 改成本机 Terre 地址。

### 3. 接到 Codex

仍在刚才的目录，用 [Codex CLI 的 MCP 命令](https://developers.openai.com/codex/mcp)登记服务：

```powershell
$repoPath = (Get-Location).Path
codex mcp add webgal -- node "$repoPath/dist/cli.js" --config "$repoPath/webgal-mcp.local.json"
codex mcp list
```

如果 Codex 已打开，先重启，再试下面的只读练习。

使用 DeepSeek Harness（`dsh`）时，请按 [DeepSeek Harness 接入指南](docs/deepseek-harness.md) 配置 `Settings → MCP` 或 `cordis.patch.yml`。

### 4. 检查连接并读开场

复制这段话给 Codex。若你在配置里用了其他工程 ID，把 `my-game` 换成你的 ID。

```text
请用 webgal_status 检查 my-game，告诉我本机文件能否读取、Terre 是否响应、工程映射是否一致，并给出下一步。如果本机文件可读，请用 scene_read 读 start.txt 的第一句对白。如果找不到 start.txt 或里面没有对白，请用 scene_list 列出候选并等我选。全程只读。
```

看到开场对白，就完成了第一次只读练习。继续试改之前，确认 Terre 的 API 检查通过且工程映射已验证。遇到问题，按 `nextSteps` 和[排查表](docs/tool-reference.md#连接与试改排查)处理。

## 试改一处对白

在 [Codex 的 MCP 配置](https://developers.openai.com/codex/mcp)里，给 `webgal` 的启动参数末尾加上 `"--state-root", "C:/Games/webgal-mcp-state"`，再重启 Codex。状态目录存放改动记录和备份，应与所有游戏及素材目录分开。用 `webgal_status` 核对 `writeToolsEnabled` 为 `true`。

1. **先看草案。** 把下面的提示发给 Codex，沿用只读练习的工程 ID 和场景相对路径。

   ```text
   请用 change_plan 为 my-game 的 start.txt 起草一处修改，把第一句对白改成「欢迎来到试用工程！」，保留说话人和其余内容。如果无法确认哪句是对白，请先问我。现在只给草案，等我亲自确认保存和交接，再重新生成计划。应用前还要等我另行确认。
   ```

2. **保存并交接。** 在 Terre 成功保存，关闭该工程的所有编辑页，再亲自告诉 Codex 已经保存并可以交接这一个文件。让 Codex 建立交接会话，重新读取并生成可应用的计划。先保持编辑页关闭。
3. **确认应用。** 检查新计划只有这处对白改动。确认后，请 Codex 先记下计划编号 `planId`，再应用并结束交接。若报告冲突、部分完成或结果不确定，先查[排查表](docs/tool-reference.md#连接与试改排查)。
4. **回到 Terre 预览。** 等 Codex 交回后，重新打开工程编辑页，确认对白已改，再从 Terre 启动预览，从开场核对这句对白。

工具参数、可修改的内容和恢复方法见[工具参考](docs/tool-reference.md)。

已验证 Windows + Codex + Terre。源码按 [PolyForm Noncommercial 1.0.0](LICENSE) 提供，限制商业使用；第三方依赖适用各自的许可证。

功能范围和实测结果见 [v0.2.0 Windows 与 Terre 验收记录](https://github.com/yuri77521/webgal-mcp-public/blob/main/docs/release-v0.2.0.md)。

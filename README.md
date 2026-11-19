# webgal-mcp

**让 Codex 帮你读懂和编辑现有的 WebGAL Terre 游戏。** 你仍在 Terre 里编辑、预览和导出游戏，Codex 可以帮你找场景、检查漏掉的素材，或起草一段对白。

默认**只读**。想让 Codex 修改文件，需要主动开启写入，并在每批修改前先保存、关闭该工程的全部编辑页。

## 快速上手

准备好 **Windows、Node.js 24、Git、Codex CLI** 和正在运行的 [WebGAL Terre](https://github.com/OpenWebGAL/WebGAL_Terre/releases)。建议第一次用一个测试工程。

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

### 3. 接到 Codex，试一句话

仍在刚才的目录，用 [Codex CLI 的 MCP 命令](https://developers.openai.com/codex/mcp)登记服务：

```powershell
$repoPath = (Get-Location).Path
codex mcp add webgal -- node "$repoPath/dist/cli.js" --config "$repoPath/webgal-mcp.local.json"
codex mcp list
```

如果 Codex 已打开，重启后试着说：

> 用 webgal 查看 my-game 的开场对白，检查有没有找不到的素材。先别改任何文件。

也可以请 Codex 给出预览链接，然后用浏览器打开。

## 想让 Codex 修改游戏？

先在 [Codex 的 MCP 配置](https://developers.openai.com/codex/mcp)里，给刚才的启动参数末尾加上一对参数，例如 `"--state-root", "C:/Games/webgal-mcp-state"`，再重启 Codex。这个目录放改动记录和备份，应与游戏及素材目录分开。

每次修改时：

1. 在 Terre 成功保存并关闭这个工程的所有编辑页，然后亲自告诉 Codex 可以开始。
2. 查看 Codex 给出的改动计划，确认后再让它应用。等待 Codex 把工程交回。
3. 重新打开 Terre 编辑页，检查结果，再自行预览或导出。若报告冲突或只改了一部分，先检查结果，别直接重试。

可以创建或修改场景、导入新素材、修改部分游戏设置。不会覆盖同名素材，也不会自动打包。工具参数、素材来源设置及恢复方法见[工具参考](docs/tool-reference.md)。

## 打不开时先检查这两处

- **Codex 看不到 `webgal`：** 用 `codex mcp list` 检查登记情况，确认 `npm run build` 成功，再重启 Codex。
- **能读文件但连不到 Terre：** 确认 Terre 在运行、端口正确，并核对 `root` 和 `terreGameDir` 是否指向同一个工程。

已验证 Windows + Codex + Terre。源码按 [PolyForm Noncommercial 1.0.0](LICENSE) 提供，限制商业使用；第三方依赖适用各自的许可证。

想参与开发？查看[下一版开发计划](https://github.com/yuri77521/webgal-mcp-public/blob/main/docs/roadmap.md)。

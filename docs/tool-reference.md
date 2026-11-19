# webgal-mcp 工具参考

第一次使用请先看 [README 快速上手](../README.md)。本页说明工具、路径和写入限制，供需要手动配置或排查问题时查阅。

## 本机配置

Codex CLI 的 `codex mcp add` 可生成配置。要手动配置时，请使用 Codex 的 `config.toml`：

```toml
[mcp_servers.webgal]
command = "node"
args = ["<absolute-repository-path>/dist/cli.js", "--config", "<absolute-local-config-path>"]
```

配置文件 `webgal-mcp.local.json` 可列出多个项目；每个项目有独立 `id`。工程的 `root` 是包含 `game/` 的目录；`terreGameDir` 是 Terre 的工程目录名。省略 Terre 地址和目录名时，仍可只读查看获准的文件。提交写入和取得预览链接需要配置对应的 Terre 工程。文件内相对路径以配置文件所在目录为准。

导入素材前，在配置文件的 `sources` 登记来源目录，例如 `{"id":"assets","root":"./my-assets"}`。导入工具只接受已登记的来源 ID 和目录内相对路径。

CLI 通过 stdio（标准输入输出）与客户端通信。直接在终端启动会等待 MCP 消息。若 Codex 找不到 `node`，可使用 Node.js 可执行文件的绝对路径。客户端仍按自身配置处理工具审批。

## 读取工具

| 工具 | 用途 |
| --- | --- |
| `webgal_status` | 传入 `projectId` 检查本机工程、Terre 连接和工程映射，并给出下一步操作 |
| `project_list` | 只列本地配置登记的工程 |
| `project_inspect` | 工程类型、入口、配置摘要、Terre 映射核对 |
| `project_scan` | 检查已保存场景中的本机引用，报告缺失项、未验证项和扫描范围 |
| `scene_list` | 递归列出场景并分页；返回路径相对于 `game/scene` |
| `scene_read` | UTF-8 原文、原始字节 SHA-256、BOM 和换行信息 |
| `scene_validate` | 解析磁盘或候选文本，检查静态引用；不执行脚本、不下载 URL |
| `asset_list` | 列出背景、立绘、BGM、语音、视频、动画目录的既有文件元数据 |
| `game_config_read` | `game/config.txt` 原文、版本及解析摘要 |
| `preview_get_url` | 返回配置对应的官方预览 URL；不打开浏览器、不遥控、不证明游戏已运行 |

排查连接时，先运行 `webgal_status` 并查看 `nextSteps`。省略 `projectId` 可查看全局状态和如何选择工程。若 MCP 因配置无效而无法启动，先检查本机配置格式、`root` 是否为现有目录，以及 `terreUrl` 是否为 HTTP loopback 根地址。

- `projectFiles.readable` 表示 `game/scene` 目录检查和 `game/config.txt` 读取都通过。失败时有 `errorCode`，仍可查看 Terre 结果。
- `terre.connectionStatus` 区分 `not_configured`（未配置）、`no_response`（未收到 HTTP 响应）和 `responded`（收到响应）。收到响应后还需看 `capabilities` 是否核对通过。未收到响应时，需核对 Terre 是否在运行及配置端口是否正确。
- `terre.mappingStatus` 区分 `not_configured`（未配置）、`unverified`（证据不足）、`mismatch`（确认目录不匹配）和 `verified`（已核对一致）。实际预览、运行和导出由用户在 Terre 检查。
- `writeToolsEnabled` 表示是否启用了写入工具。`handoffRequired` 表示每批写入都需要人工交接。检查不查询当前会话，编辑器的未保存状态仍为 `unknown`。

分页参数是 `limit`（1–100）和 `cursor`。文件列表变化或 cursor 不匹配时重新开始列表。工具业务错误使用 `isError=true` 与错误码；参数 schema 错误由 SDK 报告。

`asset_list` 汇总时用 `missingKinds` 明确列出不存在的可选素材目录；指定不存在的 kind 会报错，不把缺失目录当作空目录。

## 限制与数据边界

- 只读取已登记工程；路径和真实路径均检查，拒绝越界、Windows 特殊路径和 junction 逃逸。列表跳过链接，不递归跟随链接。
- 场景路径相对于 `game/scene`，不是任意文件读取接口。素材只返回元数据，不向模型传输二进制文件。
- 原文读取上限 1 MiB，整份工具结果上限 2 MiB，单次目录遍历最多 10,000 项，分页最多 100 项。本机 Terre 请求超时 3 秒/请求；输出超限会明确报错，不静默截断原文。
- 当前支持 UTF-8/UTF-8 BOM，拒绝 UTF-16、非法 UTF-8 和二进制。读取的是磁盘内容，不能表示 Terre 未保存 buffer。
- 解析成功不等于脚本完全有效；变量、URL、复杂模型的关联文件等可能无法静态验证。诊断保留这些限制，不把它们当作缺失本机文件。
- Terre 仅允许显式配置的 HTTP loopback 根地址，不跟随重定向，不通过系统代理请求远端。只调用已核对的 test、OpenAPI 与目录读取接口，不调用可能创建目录的用户状态/工程列表或任何写接口。
- 为保证路径边界、原始文件版本和有界分页，递归清单来自授权工程磁盘；官方 REST 用于连接、契约和逻辑路径映射交叉核对。不会使用静态服务的引擎回退来伪装工程文件存在。
- 不发送遥测或上传文件；工具返回内容交给 MCP Client，后续模型处理由客户端配置决定。
- 路径和读取期间的变化会尽量拒绝；不承诺对恶意本地进程提供文件系统沙箱。读取不代表获得工程写入权限。

## 导出前检查工程

让 Codex 运行 `project_scan`，只需传入 `projectId`。它递归检查 `game/scene` 下已保存的 `.txt`，按场景相对路径排序，跳过文件或目录链接。它从磁盘检查工程内的素材和跳转目标，外部 URL、编辑器缓冲区和游戏运行状态留给人工预览核对。

- 每个场景列出检测结果。问题包含行号、可安全显示的目标和原因。`missing` 表示确定缺失的本机文件，`unverified` 表示动态引用、外部 URL 或其他无法确认的项。`target` 仅显示可安全表达的工程相对路径。
- `scope` 列出总场景数、已检查数、未完成数及剩余范围。清单读取失败时总数为 `null`，错误码在 `inventoryError`。`complete` 表示本次已检查整个清单，缺失和待人工验证的项目仍需处理。
- 单次最多检查 100 个场景，清单最多处理 10,000 项，单个场景最多 128 KiB，场景与问题详情合计最多 128 KiB。5 秒预算在目录处理、读取和分析阶段之间检查，已经开始的单次文件系统或解析操作可以超出预算。`stopReason` 标出触发的上限。
- 还剩场景时，将 `scope.nextStartAfter` 作为下一次调用的 `startAfter`。可以用 `limit` 指定每批 1–100 个场景。遇到个别未完成的场景，可按原因处理后用 `scene_validate` 复查。工程在分批检查之间发生变化时，从头重新检查。

在 Terre 中预览关键场景并自行导出。

## 启用受控写入

```powershell
node dist/cli.js --config webgal-mcp.local.json --state-root "<absolute-private-state-directory>"
```

将同样的 `--state-root` 参数加入客户端启动 args，重启 MCP 连接后可发现 19 个工具。状态目录必须在所有工程和素材来源之外，且不能包含它们；不使用游戏目录存放备份/日志。状态目录包含原始剧情和备份，不加密、不自动清理。相对 state-root 基于启动目录，建议使用绝对路径。

新增工具：

| 工具 | 用途 |
| --- | --- |
| `asset_source_list` | 列出已登记来源 ID，不暴露物理根目录 |
| `asset_source_inspect` | 来源文件原始 SHA-256 与大小，不向模型发送二进制 |
| `write_session_begin` | 记录本次用户保存/离开声明、工程和精确路径范围；未准备好时拒绝并撤销该工程先前交接 |
| `change_plan` | 创建/编辑场景、导入素材、修改配置的有界方案；无会话只生成不可提交草案 |
| `change_apply` | 版本及来源复核、全部备份后提交；同计划同键幂等重放 |
| `write_session_end` | 交回编辑权，返回本会话记录的批次摘要 |
| `recovery_inspect` | 检查批次、当前磁盘、备份、锁；支持 planId 查询和历史分页 |
| `recovery_restore` | 仅恢复用户选定且当前版本匹配的旧文件，先备份恢复前内容 |
| `recovery_reclaim_lock` | 使用检查得到的 token 显式回收已确认死亡的 MCP 锁；活/未知 owner、维护残留均拒绝 |

先读取工程并形成草案。写入前，客户端必须通过正常用户交互取得**本次明确答复**：同工程所有编辑页已经成功保存并离开。然后以 `decision=saved-and-editors-closed` 和用户原始答复建立会话；未答复、尚未保存或保存失败时不能代填确认。`userAttested` 只是声明记录，不能证明所有 buffer 已保存；Server 无法验证声明确实来自人类。旧答复不能用于重启后的新会话。

会话默认5分钟，绑定连接、工程和精确目标范围。交接后重新生成方案，确认改动后 apply，完成后 end。用户再重新打开 Terre 编辑页，手动预览/打包。`webgal_status.writable=false` 表示没有不带会话的全局写权限；是否启用写工具看 `writeToolsEnabled`。

路径和操作约定：

- 会话/恢复的 `paths` 为工程相对路径，例如 `game/scene/start.txt`、`game/config.txt`。
- `create_scene` / `edit_scene` 的 path 相对于 `game/scene`；创建内容由 text 提供，编辑使用 expectedRevision 及基于原文的 UTF-16 半开范围 `{start,end,text}`，不计文件头 BOM。编辑按原文 offset 排序、互不重叠，不切断 emoji。
- `import_asset` 的 path 相对于对应 kind 目录，使用 sourceId、sourcePath、expectedSourceRevision；素材先提交，场景/配置随后。新场景/素材不覆盖，父目录必须已存在。
- `edit_config` 使用 `game/config.txt` 的 `expectedRevision` 和 `{key,value}` 更新。可以修改已识别的字段（例如 `Game_name`、`Description`、`Title_img`）或在格式明确时追加这些字段；其他字段和注释原样保留。目标字段重复、格式不明确或值不受支持时会拒绝写入。
- 方案提供原始 hash、有界前后文本和实际修改处 diff，截断明确标记。静态诊断会考虑本批次新增文件；它不证明游戏最终能运行。
- 所有文件当前上限1 MiB、批次32项且总计4 MiB；素材原样复制，不下载、不转码。文本编辑最多256个范围/操作。

冲突时不提供 force。failed、partial、uncertain 结果带 `isError=true` 和批次状态，必须检查实际磁盘后再决定，不能自动重试覆盖；complete 也可能带锁释放警告。多文件不具备原子性，hash 与外部写入之间仍有竞争窗口。

保留 planId：回执丢失或进程重启后，可用 `recovery_inspect` 的 projectId + planId 查到已完成或未完成批次，不需要旧会话；旧会话不能恢复写权限。无过滤时仅发现未完成批次，`includeCompleted=true` 可查历史，分页使用 offset/limit。恢复必须有新鲜交接及用户选择，拒绝后来的人工修改，不删除新建文件或备份。崩溃维护 guard 和 staging 残留需操作者核对处理，不自动清除；手动打包前先检查残留。

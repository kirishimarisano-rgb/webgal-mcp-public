# Creator 与 Editor 共用的本机选材记录

从 Creator 或 Editor 安装目录的同级目录定位 webgal-librarian。用安装的 Librarian 的 `scripts/project.py`。使用 MCP 注册的同一个 projectId；命令中的各路径各自作为一个参数。记录保存在当前用户主目录下的 `.webgal-librarian/projects/`，目录名由 projectId 派生。

- `root <projectId>` 只返回项目的库根。首次需要共享素材而记录为空时，沿用用户在当前任务给的库位置；仍未知才问一次。用 `bind <projectId> "<库根>"` 绑定已建的库。
- Creator 确定某个用途和导入目标后，执行 `remember <projectId> --scene "game/scene/start.txt" --cue "<角色/figure ID 或 bg、bgm、独立音效用途>" --path "<库内相对路径>" --target "<工程内目标路径>"`。单个角色的默认立绘直接以角色名作为 cue（例如 `林`）。区分同角色多个演出点时，在角色名之后追加片段标识。重复需求复用已选路径。
- Editor 用 `recall <projectId> --scene "<工程内场景路径>" --cue "<同一用途>"` 取出库根、原路径与工程目标；可按当前保存的工程素材反查（`--target`）。记录是选材依据，应用与否及当前素材以实际保存场景为准。只传场景时返回用途总数与最多 5 个 cue 名。无记录的手工工程也可单独绑定库。
- 搜索使用同一安装的 `library.py search`，复核使用 `show`。仅当用户明确要求相应字段时才开启来源或授权；项目记录本身只保存定位信息。素材原件移走后提示缺口并按原需求重新查找。

"""Private per-project asset choices for Creator and Editor. No game writes."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

from books import books, lookup, manifest
from catalog import check_key, read_index, readable, save, writing


def run():
    cli = argparse.ArgumentParser(description=__doc__)
    actions = cli.add_subparsers(dest="action", required=True)
    for action in ("root", "bind", "remember", "recall"):
        command = actions.add_parser(action)
        command.add_argument("project", help="registered project ID")
        if action == "bind":
            command.add_argument("library", type=Path)
        if action in ("remember", "recall"):
            command.add_argument("--scene", required=True, help="saved scene path")
            if action == "remember":
                command.add_argument("--cue", required=True)
            else:
                command.add_argument("--cue")
                command.add_argument("--target")
        if action == "remember":
            command.add_argument("--path", required=True)
            command.add_argument("--target", required=True, help="project-relative target path")
    args = cli.parse_args()
    if args.action in ("recall", "remember"):
        scene = args.scene.removeprefix("game/scene/")
        check_key(scene)
        args.scene = "game/scene/" + scene
        if args.target:
            target = args.target.removeprefix("game/")
            check_key(target)
            args.target = "game/" + target
    key = hashlib.sha256(args.project.encode("utf-8")).hexdigest()
    directory = Path.home() / ".webgal-librarian" / "projects" / key
    path = directory / "choices.json"
    if args.action in ("root", "recall"):
        raw = read_index(path)
        if raw is None:
            return {"库根": None}
        data = json.loads(raw)
        result = {"库根": data["库根"]}
        if args.action == "recall":
            cues = data["场景"].get(args.scene, {})
            if args.target:
                choices = [choice for choice in cues.values() if choice["工程目标"] == args.target]
                unique = {choice["路径"]: choice for choice in choices}
                by_cue = cues.get(args.cue)
                if by_cue and by_cue["工程目标"] == args.target:
                    result["选材"] = by_cue
                else:
                    result["选材"] = next(iter(unique.values())) if len(unique) == 1 else None
            elif args.cue:
                result["选材"] = cues.get(args.cue)
            else:
                result["用途总数"] = len(cues)
                result["用途示例"] = sorted(cues)[:5]
        return result
    directory.mkdir(parents=True, exist_ok=True)
    with writing(directory):
        raw = read_index(path)
        data = json.loads(raw) if raw else {"场景": {}}
        if args.action == "bind":
            root = args.library.resolve()
            manifest(root)
            if data.get("库根") and data["库根"] != str(root):
                raise ValueError("该项目已有其他素材库记录，请核对项目与库根")
            data["库根"] = str(root)
        else:
            if "库根" not in data:
                raise ValueError("请先绑定用户指定的库")
            root = Path(data["库根"])
            manifest(root)
            lookup(books(root), args.path)
            if not readable(root, args.path, {}):
                raise ValueError("所选素材已不可读")
            data["场景"].setdefault(args.scene, {})[args.cue] = {
                "路径": args.path, "工程目标": args.target}
        save(path, raw, json.dumps(data, ensure_ascii=False, indent=2))
        return {"库根": data["库根"]}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(run(), ensure_ascii=False))
    except (OSError, ValueError) as err:
        sys.exit(str(err))

"""Maintain a WebGAL asset INDEX.md with the Python 3.10+ standard library."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path, PureWindowsPath
import stat
import sys
import tempfile

HEADER = "# WebGAL 素材库\n\n<!-- webgal-librarian v1 -->\n"
FIELDS = ("名称", "类型", "描述", "标签", "来源", "授权")
IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".bmp"}
AUDIO = {".ogg", ".mp3", ".wav", ".m4a", ".flac", ".aac", ".opus", ".weba"}
CATEGORIES = {
    "背景": {"bg", "background", "backgrounds", "背景"},
    "立绘": {"figure", "figures", "portrait", "portraits", "立绘", "立繪"},
    "BGM": {"bgm", "music", "音乐", "音樂", "配乐", "配樂"},
    "音效": {"se", "sfx", "soundeffect", "soundeffects", "音效", "効果音"},
}
UNKNOWN = "未知"


def linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def check_key(key):
    if (not key or any(part in {"", ".", ".."} for part in key.split("/"))
            or "\\" in key or any(ord(ch) < 32 for ch in key)
            or PureWindowsPath(key).drive or (os.name == "nt" and ":" in key)):
        raise ValueError(f"无效的库内相对路径 {key!r}")


def category(key):
    path = Path(key)
    image = path.suffix.lower() in IMAGES
    choices = ("背景", "立绘") if image else ("BGM", "音效")
    for part in reversed(path.parent.parts):
        for choice in choices:
            if part.casefold() in CATEGORIES[choice]:
                return choice
    return "图片待分类" if image else "音频待分类"


def discover(root):
    def visit(directory):
        for path in sorted(directory.iterdir(), key=lambda p: p.name):
            if linked(path):
                continue
            if path.is_dir():
                if path.name != ".git":
                    yield from visit(path)
            elif path.is_file() and path.suffix.lower() in IMAGES | AUDIO:
                key = path.relative_to(root).as_posix()
                check_key(key)
                yield key

    return set(visit(root))


def readable(root, key, names):
    path = root
    try:
        for part in key.split("/"):
            # Case-only renames can leave the old spelling openable on Windows.
            if path not in names:
                names[path] = {entry.name for entry in path.iterdir()}
            if part not in names[path]:
                return False
            path = path / part
            if linked(path):
                return False
        if path.is_file():
            with path.open("rb") as media:
                media.read(1)
            return True
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        pass
    return False


def read_index(path):
    try:
        if linked(path) or not path.is_file():
            raise ValueError(f"{path.name} 必须是普通文件")
        return path.read_bytes()
    except FileNotFoundError:
        return None


def parse(raw):
    text = HEADER if raw is None else raw.decode("utf-8-sig")
    if not text.replace("\r\n", "\n").startswith(HEADER):
        raise ValueError("INDEX.md 已存在且格式不同，已保留原文件。请选择迁移方式或其他素材库。")
    lines = text.splitlines(keepends=True)
    rows = {}
    row = None
    for number, line in enumerate(lines):
        value = line.rstrip("\r\n")
        if value.startswith("## "):
            key = value[3:]
            check_key(key)
            if key in rows:
                raise ValueError(f"重复路径 {key}，请核对两条记录的手动注记")
            row = rows[key] = {}
        elif row is not None and value.startswith("- "):
            field, sep, content = value[2:].partition(":")
            if sep and field in FIELDS:
                if field in row:
                    raise ValueError(f"{key} 的 {field} 栏重复")
                row[field] = (number, content.removeprefix(" "))
    for key, row in rows.items():
        if row.keys() != set(FIELDS):
            raise ValueError(f"{key} 缺少字段 {', '.join(set(FIELDS) - row.keys())}")
    return lines, rows


@contextmanager
def writing(root):
    lock = root / ".webgal-librarian.lock"
    try:
        lock.mkdir()
    except FileExistsError:
        raise ValueError("素材库有写入锁。请等待当前操作结束；若上次中断，先检查锁的归属。") from None
    try:
        yield
    finally:
        lock.rmdir()


def save(path, original, text):
    data = text.encode("utf-8")
    if original and original.startswith(b"\xef\xbb\xbf"):
        data = b"\xef\xbb\xbf" + data
    if data == original:
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as staged:
        temp = Path(staged.name)
    try:
        temp.write_bytes(data)
        if read_index(path) != original:
            raise ValueError("INDEX.md 同时被编辑，请重新读取后重试")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def scan(root, original, lines, rows):
    found = discover(root)
    added = sorted(found - rows.keys())
    text = "".join(lines)
    newline = "\r\n" if "\r\n" in text else "\n"
    for key in added:
        kind = category(key)
        name = Path(key).stem
        fields = (name, kind, f"{name}（{Path(key).suffix[1:].upper()}）", "", UNKNOWN, UNKNOWN)
        if not text.endswith(newline):
            text += newline
        text += newline + f"## {key}" + newline
        text += "".join(f"- {field}: {value}{newline}" for field, value in zip(FIELDS, fields))
    save(root / "INDEX.md", original, text)
    return {"新增": len(added), "现存": len(found), "缺失": sorted(rows.keys() - found)}


def annotate(args, root, original, lines, rows):
    if args.path not in rows:
        raise ValueError(f"索引里没有 {args.path}")
    row = rows[args.path]
    field = "标签" if args.action == "tag" else args.field
    index, old = row[field]
    value = args.value.strip()
    if not value or len(value.splitlines()) != 1:
        raise ValueError("字段值须为一行非空文本")
    if args.action == "tag":
        tags = [tag.strip() for tag in old.split("、") if tag.strip()]
        if value in tags:
            return {"路径": args.path, field: old}
        value = "、".join([*tags, value])
    if field == "类型" and value not in (*CATEGORIES, "图片待分类", "音频待分类"):
        raise ValueError(f"未知类型 {value}")
    line = lines[index]
    end = line[len(line.rstrip("\r\n")):]
    lines[index] = f"- {field}: {value}{end}"
    save(root / "INDEX.md", original, "".join(lines))
    return {"路径": args.path, field: value}


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("init", "scan", "candidates", "tag", "set"):
        command = commands.add_parser(action)
        command.add_argument("library", type=Path)
        if action in ("scan", "init"):
            command.add_argument("--layout-confirmed", action="store_true",
                                 help="用户已明确选择了目录结构，可为现有素材夹建立索引")
        if action == "candidates":
            command.add_argument("--type")
            command.add_argument("--path")
        if action in ("tag", "set"):
            command.add_argument("path")
            if action == "set":
                command.add_argument("field", choices=FIELDS)
            command.add_argument("value")
    args = parser.parse_args()
    root = args.library.resolve()
    if args.action == "init":
        root.mkdir(parents=True, exist_ok=True)
    path = root / "INDEX.md"
    if args.action == "candidates":
        raw = read_index(path)
        if raw is None:
            raise ValueError("请先扫描素材库以建立 INDEX.md")
        _, rows = parse(raw)
        results = []
        names = {}
        for key, row in rows.items():
            if args.path is not None and key != args.path:
                continue
            fields = {field: cell[1] for field, cell in row.items()}
            if (args.type is None or args.type == fields["类型"]) and readable(root, key, names):
                results.append({"路径": key, **fields})
        return results
    with writing(root):
        raw = read_index(path)
        lines, rows = parse(raw)
        if args.action in ("scan", "init"):
            if raw is None and not args.layout_confirmed and any(
                entry.name != ".webgal-librarian.lock" for entry in root.iterdir()
            ):
                raise ValueError("请先问用户：保持现有目录，只建索引，还是先看按类型整理文件夹的方案？"
                                 "收到明确的目录选择后再继续。")
            return scan(root, raw, lines, rows)
        return annotate(args, root, raw, lines, rows)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(run(), ensure_ascii=False, indent=2))
    except (OSError, ValueError) as error:
        sys.exit(str(error))

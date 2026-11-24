"""Search and maintain a local WebGAL Markdown catalog (Python 3.10+)."""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys

from books import assign, books, edit, lookup, manifest, pending_summary, recover, scan
from catalog import CATEGORIES, FIELDS, check_key, discover, readable, writing


def encode(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def rows(loaded):
    for (kind, group), book in loaded.items():
        for key, row in book.rows.items():
            yield kind, group, key, {field: cell[1] for field, cell in row.items()}


def excerpt(text, term):
    start = max(0, text.casefold().find(term) - 16)
    return text[start:start + 72]


def search(args, root, loaded, words):
    terms = list(dict.fromkeys(t.strip().casefold() for t in words if t.strip()))
    if args.directory:
        check_key(args.directory)
    if args.offset < 0:
        raise ValueError("offset 须为非负整数")
    hits = []
    for _, _, key, fields in rows(loaded):
        if args.directory and not key.startswith(args.directory + "/"):
            continue
        ordinary = [fields[f].casefold() for f in ("名称", "描述", "标签")]
        if not all(any(word.casefold() in value for value in ordinary) for word in args.require):
            continue
        # Rights conditions use whole-field matches; a negation must never match a grant.
        if args.license is not None and (fields["授权"].strip() in ("", "未知")
                                          or fields["授权"].strip().casefold() != args.license.strip().casefold()):
            continue
        if args.source is not None and (fields["来源"].strip() in ("", "未知")
                                         or args.source.casefold() not in fields["来源"].casefold()):
            continue
        evidence = []
        score = 0
        matched = 0
        for term in terms:
            for field, weight in (("标签", 4), ("名称", 3), ("描述", 2)):
                value = fields[field]
                if term in value.casefold():
                    score += weight
                    matched += 1
                    if field == "标签":
                        sample = next((t for t in value.split("、") if term in t.casefold()), term)
                    else:
                        sample = excerpt(value, term)
                    if sample not in evidence:
                        evidence.append(sample[:72])
                    break
        if terms and not matched:
            continue
        if not evidence:
            evidence.append(fields["名称"][:72])
        description = fields["描述"]
        if description:
            # Distinguish nearby variants on the first page (the observation often follows shared metadata).
            observation = description.rpartition("画面观察：")[2]
            snippet = next((excerpt(observation, t) for t in terms if t in observation.casefold()),
                           observation[-72:])
            if snippet not in evidence:
                evidence.append(snippet)
        item = {"路径": key, "依据": " · ".join(evidence)[:190]}
        if args.source is not None:
            item["来源"] = excerpt(fields["来源"], args.source.casefold())
        if args.license is not None:
            item["授权"] = fields["授权"]
        hits.append((-matched, -score, key, item))
    names = {}
    result = {"候选": [], "还有": False, "下一页": None, "超限": 0}
    position = 0
    for _, _, key, item in sorted(hits):
        if not readable(root, key, names):
            continue
        position += 1
        if position <= args.offset:
            continue
        # Reserve room for the actual continuation cursor and Windows CRLF.
        next_page = {**result, "还有": True, "下一页": position}
        if len(encode({**next_page, "候选": [item]})) + 2 > 2000:
            result["超限"] += 1
            continue
        if (len(result["候选"]) == 5
                or len(encode({**next_page, "候选": [*result["候选"], item]})) + 2 > 2000):
            result.update({"还有": True, "下一页": position - 1})
            break
        result["候选"].append(item)
    return result


def stats(args, root, loaded):
    keys = {key for _, _, key, _ in rows(loaded)}
    found = discover(root)
    pending = sorted(found - keys)
    missing = sorted(keys - found)
    if args.listing:
        entries = pending if args.listing == "pending" else missing
        return {"总数": len(entries), "路径": entries[args.offset:args.offset + 10]}
    selected = [(k, g, key) for k, g, key, _ in rows(loaded)
                if (not args.type or args.type == k) and (not args.group or args.group == g)]
    return {"类型数量": dict(Counter(k for k, _, _ in selected)),
            "已收录": len(selected), "缺失": sum(key not in found for _, _, key in selected),
            **pending_summary(pending)}


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    commands = p.add_subparsers(dest="action", required=True)
    for action in ("init", "scan", "recover", "assign", "search", "show", "stats", "tag", "set"):
        c = commands.add_parser(action)
        c.add_argument("library", type=Path)
        if action in ("init", "scan"):
            c.add_argument("--layout-confirmed", action="store_true")
        if action in ("search", "stats", "assign"):
            c.add_argument("--type", choices=CATEGORIES, required=action == "assign")
            c.add_argument("--group", required=action == "assign")
        if action == "search":
            c.add_argument("--dir", dest="directory")
            c.add_argument("--term", action="append", default=[])
            c.add_argument("--fallback", action="append", default=[],
                           help="首轮无结果时在相同硬条件内使用的备用词")
            c.add_argument("--require", action="append", default=[])
            c.add_argument("--offset", type=int, default=0)
            c.add_argument("--source")
            c.add_argument("--license")
        if action == "stats":
            c.add_argument("--list", dest="listing", choices=("pending", "missing"))
            c.add_argument("--offset", type=int, default=0)
        if action == "show":
            c.add_argument("--path", required=True)
            c.add_argument("--source", action="store_true")
            c.add_argument("--license", action="store_true")
        if action in ("assign", "set", "tag"):
            c.add_argument("path")
        if action == "set":
            c.add_argument("field", choices=FIELDS)
        if action in ("set", "tag"):
            c.add_argument("value")
    return p


def run():
    args = parser().parse_args()
    root = args.library.resolve()
    if args.action == "init":
        root.mkdir(parents=True, exist_ok=True)
    if args.action in ("search", "show", "stats"):
        manifest(root)
        if args.action == "search":
            loaded = books(root, args.type, args.group)
            result = search(args, root, loaded, args.term)
            if not result["候选"] and args.fallback and not args.offset:
                result = search(args, root, loaded, args.fallback)
            return result
        loaded = books(root)
        if args.action == "stats":
            if args.offset < 0:
                raise ValueError("offset 须为非负整数")
            return stats(args, root, loaded)
        row = lookup(loaded, args.path).rows[args.path]
        if not readable(root, args.path, {}):
            raise ValueError("素材文件当前不可读")
        fields = ["名称", "类型", "描述", "标签"]
        if args.source:
            fields.append("来源")
        if args.license:
            fields.append("授权")
        return {"路径": args.path, **{f: row[f][1] for f in fields}}
    with writing(root):
        if args.action == "recover":
            return recover(root)
        create = args.action in ("init", "scan")
        manifest(root, create, create and args.layout_confirmed)
        loaded = books(root)
        if create:
            return scan(root, loaded)
        if args.action == "assign":
            return assign(root, loaded, args.path, args.type, args.group)
        if args.action == "set" and args.field == "类型":
            if args.value not in CATEGORIES:
                raise ValueError("未知类型")
            current = lookup(loaded, args.path)
            if current.path.parent.name == args.value:
                return {"路径": args.path, "类型": args.value}
            if args.value == "立绘":
                raise ValueError("请用 assign --type 立绘 --group 角色名 指定归属")
            return assign(root, loaded, args.path, args.value, "_通用")
        book = lookup(loaded, args.path)
        return edit(book, args.path, "标签" if args.action == "tag" else args.field,
                    args.value, args.action == "tag")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(encode(run()))
    except (OSError, ValueError) as error:
        sys.exit(str(error))

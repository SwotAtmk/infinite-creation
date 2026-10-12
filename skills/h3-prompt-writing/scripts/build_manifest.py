#!/usr/bin/env python3
# build_manifest.py
# ========================================
# 资产库索引 manifest.json（doc/consistency-plan.md §6.3），Phase 3「命名标签库 → manifest 索引工具」。
#
# 作用：把「散落在磁盘上的角色/场景资产」收成一份索引，@角色 / #场景 → 视图路径 + 元数据，
#       供 compile_storyboard.py --manifest 解析契约里值留空的 refs（§6.1：Phase 2 由 manifest 解析 @标签），
#       并作为 §6.2 的资产验收检查（视图齐不齐、契约引用的资产在不在）。
#
# 两种模式：
#   --storyboard sb.json   标签名与元数据（do_not_change / anchors / name_en）取自契约，按 asset 目录扫描视图
#   --assets-dir assets    无契约时纯扫描目录，标签名取目录名（char/CHAR_001 → @CHAR_001）
#
# 视图命名约定（§6.2）：
#   角色 char/<CID>/  front / side / back / closeup（头部特写）——扩展名 png/jpg/jpeg/webp 不限
#   场景 scene/<SID>/ wide
#
# 用法：
#   python build_manifest.py --storyboard storyboard.json --out manifest.json
#   python build_manifest.py --storyboard storyboard.json --check          # 验收，缺视图/缺目录 → 退出码 1
#   python build_manifest.py --assets-dir assets --out manifest.json
#
# 只依赖标准库。

import argparse
import json
import sys
from pathlib import Path, PurePosixPath

CHAR_VIEWS = ("front", "side", "back", "closeup")
SCENE_VIEWS = ("wide",)
EXTS = (".png", ".jpg", ".jpeg", ".webp")


def safe_print(msg):
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("ascii", errors="replace").decode("ascii"))


def scan_views(asset_dir, asset_root, view_names):
    """在 asset_root/asset_dir 下按命名约定找视图 → {view: 契约相对路径}。

    落盘路径保留契约里的 asset 前缀（如 assets/char/CHAR_001/front.png），保证清单可跨机流转；
    asset_root 只用于判断文件是否真的存在。
    """
    views = {}
    if not asset_dir:
        return views
    abs_dir = Path(asset_root) / asset_dir if asset_root else Path(asset_dir)
    prefix = PurePosixPath(str(asset_dir).replace("\\", "/"))
    if not abs_dir.is_dir():
        return views
    lowered = {p.name.lower(): p for p in abs_dir.iterdir() if p.is_file()}
    for view in view_names:
        for ext in EXTS:
            hit = lowered.get(view + ext)
            if hit:
                views[view] = str(prefix / hit.name)
                break
    return views


def notes_for(entry):
    """人读备注：英文名 + 静态特征（管理字段，可中文）。"""
    bits = [str(entry.get("name_en") or "").strip()]
    for f in entry.get("static_features") or []:
        bits.append(str(f).strip())
    return " ".join(b for b in bits if b)


def build_from_storyboard(sb, asset_root):
    manifest = {"characters": {}, "scenes": {}}
    for tag, c in (sb.get("characters") or {}).items():
        manifest["characters"][tag] = {
            "views": scan_views(c.get("asset"), asset_root, CHAR_VIEWS),
            "do_not_change": list(c.get("do_not_change") or []),
            "notes": notes_for(c),
        }
    for tag, s in (sb.get("scenes") or {}).items():
        manifest["scenes"][tag] = {
            "views": scan_views(s.get("asset"), asset_root, SCENE_VIEWS),
            "anchors": list(s.get("anchors") or []),
        }
    return manifest


def build_from_dir(assets_dir):
    manifest = {"characters": {}, "scenes": {}}
    for kind, view_names, group, prefix in (
        ("char", CHAR_VIEWS, "characters", "@"),
        ("scene", SCENE_VIEWS, "scenes", "#"),
    ):
        base = Path(assets_dir) / kind
        if not base.is_dir():
            continue
        for d in sorted(p for p in base.iterdir() if p.is_dir()):
            rel = PurePosixPath(str(assets_dir).replace("\\", "/")) / kind / d.name
            manifest[group][prefix + d.name] = {
                "views": scan_views(rel, assets_dir, view_names),
            }
            if group == "scenes":
                manifest[group][prefix + d.name]["anchors"] = []
            else:
                manifest[group][prefix + d.name]["do_not_change"] = []
                manifest[group][prefix + d.name]["notes"] = d.name
    return manifest


def check_manifest(manifest, sb, asset_root):
    """验收（§6.2）：每个标签至少有一个视图；契约 refs 指向的文件存在。返回问题清单。"""
    problems = []
    for group, view_names in (("characters", CHAR_VIEWS), ("scenes", SCENE_VIEWS)):
        for tag, entry in (manifest.get(group) or {}).items():
            views = entry.get("views") or {}
            if not views:
                problems.append("%s 无任何视图（期望 %s）" % (tag, "/".join(view_names)))
            else:
                for view, rel in views.items():
                    if not (Path(asset_root) / rel).is_file():
                        problems.append("%s 视图 %s 指向不存在的文件：%s" % (tag, view, rel))
    if sb is not None:
        for tag in (sb.get("characters") or {}):
            if tag not in (manifest.get("characters") or {}):
                problems.append("契约角色 %s 未登记进 manifest" % tag)
        for tag in (sb.get("scenes") or {}):
            if tag not in (manifest.get("scenes") or {}):
                problems.append("契约场景 %s 未登记进 manifest" % tag)
    return problems


def build_parser():
    p = argparse.ArgumentParser(description="资产库索引 manifest.json（§6.3）+ 资产验收检查")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--storyboard", help="由契约生成：标签名/元数据取自 storyboard.json")
    src.add_argument("--assets-dir", help="纯扫描目录：标签名取目录名（如 assets/char/CHAR_001 → @CHAR_001）")
    p.add_argument("--out", help="写出 manifest.json（--check 时可不给）")
    p.add_argument("--asset-root", default=None, help="资产实际所在根目录（默认取契约文件所在目录）")
    p.add_argument("--check", action="store_true", help="只验收：缺视图/缺目录/契约标签未登记 → 退出码 1")
    return p


def main():
    args = build_parser().parse_args()
    sb = None
    if args.storyboard:
        sb_path = Path(args.storyboard)
        sb = json.loads(sb_path.read_text(encoding="utf-8"))
        asset_root = args.asset_root or str(sb_path.resolve().parent)
        manifest = build_from_storyboard(sb, asset_root)
    else:
        asset_root = args.asset_root or args.assets_dir
        manifest = build_from_dir(args.assets_dir)

    out_chars = len(manifest.get("characters") or {})
    out_scenes = len(manifest.get("scenes") or {})
    safe_print("== build_manifest: 角色 %d，场景 %d，asset_root=%s ==" % (out_chars, out_scenes, asset_root))

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        safe_print("已写出：%s" % out)

    problems = check_manifest(manifest, sb, asset_root)
    if problems:
        safe_print("\n-- 验收问题 %d 项 --" % len(problems))
        for p in problems:
            safe_print("[MISS] %s" % p)
        return 1
    if args.check:
        safe_print("验收通过：资产视图齐备，契约标签全部登记。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

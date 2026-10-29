#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_asset_blocks.py — 资产提示词结构自检（P2 出稿门禁）

背景（2026-10-19 实战回写）：
  实际交付中反复出现四类硬伤，全部是**结构性**的、机器可判的，却被人工目检漏掉：
    ① 跨条引用（"同规格""见母版""同图2""降级条款同图2"）——单条复制出去就是残缺指令；
    ② 角色同时写"立绘/全身完整入画"+"四格"——模型做加法，出成 5 格（正面被画两次）；
    ③ 九宫格缺模板字段（【场景定位】【九宫格内容分配】【参考场景锁定模式】）——
       出图后无法判断哪格是哪个机位，也约束不住建筑漂移；
    ④ 道具四格字段名不统一（"正面/45°侧视/顶部俯视" vs "正面视图/45°侧视图/顶部俯视图"），
       缺"道具设定图"标识 → 模型不知道该出设定板还是单张图。
  本脚本把这些做成可机械判定的门禁，**资产段写完必须跑一次，FAIL 清零再进分镜**。

用法：
  python scripts/check_asset_blocks.py <含资产提示词的 md>
      [--min-blocks 3] [--json]

判定单元：以 `#### 图N · 名称（类型）`（# 数不限，图N 开头）为块起点，到下一个同级或更高级标题为止。

规则码：
  A1 块内出现跨条引用（不自包含）              ERROR
  A2 块内未写明 16:9 整板比例                  ERROR
  A3 九宫格缺字段 / 缺 9 格声明 / 缺标注降级    ERROR
  A4 角色缺"全图共 4 格"/"五官 10 项锁定"/声纹/负向词   ERROR
  A5 角色块出现旧称"主图"（易出 5 格）          ERROR
  A6 道具缺四格字段名 / 缺"道具设定图" / 未禁手持  ERROR
  A7 块类型无法判定                          WARN
  A8 整份资产块数少于 --min-blocks            WARN

退出码：0 = 全 PASS（允许 WARN）· 1 = 有 ERROR · 2 = 用法/读取错误
"""

import json
import os
import re
import sys

BLOCK_RE = re.compile(r"^#{2,6}\s*\*{0,2}\s*图\s*(\d+)\s*[*]{0,2}\s*[·:：\-—]?\s*(.*)$", re.M)
HEAD_RE = re.compile(r"^(#{1,6})\s", re.M)

# 跨条引用：单条提示词复制出去即断
CROSS_REF_PATTERNS = [
    (r"同上", "同上"),
    (r"同规格", "同规格"),
    (r"见母版", "见母版"),
    (r"同图\s*\d", "同图N"),
    (r"见第[一二三四五六七八九十0-9]+部分", "见第X部分"),
    (r"参见[^，。；\n]{0,12}", "参见…"),
    (r"按上述", "按上述"),
    (r"同前", "同前"),
    (r"沿用上文", "沿用上文"),
    (r"降级条款同", "降级条款同X"),
]

SCENE_GRID_FIELDS = ["【场景定位】", "【九宫格内容分配】", "【参考场景锁定模式】"]
PROP_FIELDS = ["正面视图", "45° 侧视图", "顶部俯视图", "关键细节特写"]
PROP_FIELDS_ALT = ["正面视图", "45°侧视图", "顶部俯视图", "关键细节特写"]


def split_blocks(text):
    """按 `图N` 标题切块，返回 [(图号, 标题, 正文)]。

    块的右边界 = **下一个同级或更高级标题**，不是「下一个图N」。
    否则最后一个资产块会一路吞到文末（把分镜段、说明段全算进资产块，
    既漏判该块自身，又会把别处的「同上」误报成资产块的跨条引用）。
    """
    lines = text.split("\n")
    offsets, cursor = [], 0
    for line in lines:
        offsets.append(cursor)
        cursor += len(line) + 1

    heading_levels = []
    for line in lines:
        match = re.match(r"^(#{1,6})\s", line)
        heading_levels.append(len(match.group(1)) if match else 0)

    blocks = []
    for index, line in enumerate(lines):
        match = BLOCK_RE.match(line)
        if not match:
            continue
        level = heading_levels[index]
        end = len(text)
        for later in range(index + 1, len(lines)):
            if heading_levels[later] and heading_levels[later] <= level:
                end = offsets[later]
                break
        body = text[offsets[index]:end]
        blocks.append((match.group(1), match.group(2).strip(), body))
    return blocks


def classify(title, body):
    """按标题关键词 + 必备字段判定块类型。

    判定顺序有讲究：**道具必须先判**——道具也是四格版式，正文里同样写「全图共 4 格」，
    若先判角色会把全部道具块误当角色，报出一串「缺五官/缺声纹」的假 FAIL。
    """
    if "道具设定图" in body or "道具设定" in body or "道具" in title:
        return "道具"
    if "九宫格" in title or re.search(r"全图共\s*9\s*格", body):
        return "九宫格"
    if (re.search(r"全图共\s*4\s*格", body) or "立绘" in body
            or "五官" in body or "声纹" in body
            or re.search(r"[SABC]\s*级|男主|女主|主角|反派", title)):
        return "角色"
    if re.search(r"四格|4\s*格", body) and re.search(r"视图|材质|尺寸参照|设定", body):
        return "道具"
    if "母版" in title or "无人空镜" in body:
        return "场景母版"
    return "未知"


def check_block(number, title, body, kind):
    errors, warns = [], []
    tag = f"图{number}"

    # A1 自包含
    for pattern, label in CROSS_REF_PATTERNS:
        if re.search(pattern, body):
            errors.append(f"A1 {tag} 出现跨条引用「{label}」——单条复制出去即断，必须把内容逐条写死")

    # A2 16:9
    if not re.search(r"16\s*[:：]\s*9", body):
        errors.append(f"A2 {tag} 未写明「16:9」整板比例（资产板固定 16:9，不随成片画幅变）")

    if kind == "九宫格":
        for field in SCENE_GRID_FIELDS:
            # 字段名允许带后缀（如「【参考场景锁定模式 · 模式A 档 · 仅允许摄影机移动】」）
            if not re.search(re.escape(field[:-1]) + r"[^】]*】", body):
                errors.append(f"A3 {tag} 九宫格缺模板字段 {field}（八字段硬性，缺一即不合规）")
        if not re.search(r"全图共\s*9\s*格", body):
            errors.append(f"A3 {tag} 九宫格未显式声明「全图共 9 格」")
        if "仅允许摄影机移动" not in body and "允许按子区域切换机位" not in body:
            errors.append(f"A3 {tag} 九宫格缺【参考场景锁定模式】正文（模式A档或模式B档原文）")
        if not re.search(r"1\s*[~～-]\s*9", body) or "对照表" not in body:
            errors.append(f"A3 {tag} 九宫格缺标注降级条款（中文崩字 → 格内编号 1~9 + 图外对照表）")

    if kind == "角色":
        if not re.search(r"全图共\s*4\s*格", body):
            errors.append(f"A4 {tag} 角色未声明「全图共 4 格」——模型会做加法出成 5 格")
        if "五官 10 项锁定" not in body and "五官10项锁定" not in body:
            errors.append(f"A4 {tag} 角色缺「五官 10 项锁定」（模板字段名，勿改写）")
        if "声纹" not in body:
            errors.append(f"A4 {tag} 角色缺图底声纹锚（图底波形，非文字）")
        if not re.search(r"≤\s*8\s*词|8\s*词", body):
            errors.append(f"A4 {tag} 角色缺「≤8 词音色速览标签」")
        if "fifth panel" not in body.lower():
            errors.append(f"A4 {tag} 角色负向词缺 fifth panel / extra panel（防第 5 格）")
        negative = body.lower()
        if not any(token in negative for token in
                   ("different face", "second face", "second recognizable face", "another face")):
            errors.append(f"A4 {tag} 角色负向词缺「防第二张脸」（different face / second face）")
        # A5 只抓「正向使用主图」：先把「不设/无/禁…主图」这类否定句摘掉再判
        scrubbed = re.sub(r"[不无禁勿][^，。；\n]{0,8}主图", "", body)
        scrubbed = re.sub(r"主图[^，。；\n]{0,6}(?:删除|去掉|不要)", "", scrubbed)
        if "主图" in scrubbed:
            errors.append(f"A5 {tag} 出现旧称「主图」（非否定用法）——与四格并存会让模型出 5 格，改称「正面格」")

    if kind == "道具":
        if "道具设定图" not in body:
            errors.append(f"A6 {tag} 道具缺「道具设定图」标识（模板标题字段）")
        missing = [f for f in PROP_FIELDS if f not in body and f.replace(" ", "") not in body.replace(" ", "")]
        if missing:
            errors.append(f"A6 {tag} 道具四格字段名不全，缺：{'、'.join(missing)}（须用模板原名）")
        if not re.search(r"禁止手持|不得手持|不出现手", body):
            errors.append(f"A6 {tag} 道具未禁手持（道具图必须无人、无手）")

    if kind == "未知":
        message = (f"A7 {tag} 块类型无法判定——正文含分格表述，但缺少模板标识字段"
                   "（场景写「母版/全图共 9 格」、角色写「全图共 4 格」、道具写「道具设定图」）")
        if re.search(r"四格|九宫格|\d\s*×\s*\d|全图共\s*\d+\s*格", body):
            errors.append(message)
        else:
            warns.append(message)

    return errors, warns


def main():
    argv = sys.argv[1:]
    files = [a for a in argv if not a.startswith("-")]
    if not files:
        print(__doc__)
        sys.exit(2)
    path = files[0]
    if not os.path.exists(path):
        print(f"[-] 文件不存在：{path}")
        sys.exit(2)
    min_blocks = 3
    if "--min-blocks" in argv:
        try:
            min_blocks = int(argv[argv.index("--min-blocks") + 1])
        except (IndexError, ValueError):
            print("[-] --min-blocks 需要整数")
            sys.exit(2)
    try:
        with open(path, encoding="utf-8-sig") as handle:
            text = handle.read()
    except (OSError, UnicodeDecodeError) as exc:
        print(f"[-] 读取失败：{exc}")
        sys.exit(2)

    blocks = split_blocks(text)
    if not blocks:
        print("[!] 未识别到任何「图N」资产块——请确认块标题形如 `#### 图1 · 场景名（母版）`")
        sys.exit(1)

    errors, warns, stats = [], [], {}
    print(f"[i] 识别到 {len(blocks)} 个资产块（{os.path.basename(path)}）")
    for number, title, body in blocks:
        kind = classify(title, body)
        stats[kind] = stats.get(kind, 0) + 1
        block_errors, block_warns = check_block(number, title, body, kind)
        errors.extend(block_errors)
        warns.extend(block_warns)
        state = "FAIL" if block_errors else "PASS"
        print(f"[{'x' if block_errors else '+'}] 图{number:<3} {kind:<5} {state}  {title[:40]}")

    if len(blocks) < min_blocks:
        warns.append(f"A8 资产块仅 {len(blocks)} 个，少于预期 {min_blocks} 个——核对是否有漏出的资产")

    print("[i] 分类统计：" + " · ".join(f"{k}{v}" for k, v in sorted(stats.items())))
    for warning in warns:
        print("[!] WARN: " + warning)
    for error in errors:
        print("[-] FAIL: " + error)
    if "--json" in argv:
        print(json.dumps({"blocks": len(blocks), "stats": stats,
                          "errors": errors, "warnings": warns}, ensure_ascii=False, indent=2))
    print(f"[+] PASSED 资产块 {len(blocks)} · FAIL {len(errors)} · WARN {len(warns)}"
          if not errors else f"[-] {len(errors)} error(s)")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()

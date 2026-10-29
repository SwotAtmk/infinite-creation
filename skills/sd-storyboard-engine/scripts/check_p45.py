#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_p45.py — P4.5 预演故事板结构机检（交付门禁）

背景（2026-10-20 粉丝反馈）：
  P4.5 附件此前明确「不参与机检」，交付时少段、少格、六问缺失、
  术语混入、甚至写「同上」都能过——内容不对也没人拦。
  本脚本把 P4.5 的结构做成可机械判定的门禁：**附件写完必须跑，FAIL 清零才交付**。

用法：
  python sd-storyboard-engine/scripts/check_p45.py <预演故事板.md>
      [--segments N]   期望段数（从投喂稿/项目段数传入）；不传则只做内部一致性
      [--m2]           已入库形态，允许「已核验 / 看图」类表述
      [--json]
      [--self-test]

规则码：
  P450 文件命名（须以 -预演故事板.md 结尾）                        WARN
  P451 段结构：缺「本段要验什么 / 风险提示 / 故事板提示词 / 看图先看这三点」  ERROR
  P452 格数：声明（N 格）与实际「第 k 格」数量/编号不一致              ERROR
  P453 六问：每格缺项（谁在哪/朝哪/看哪/做什么/镜头在哪/光从哪来）      ERROR(缺≥2) / WARN(缺1)
  P454 术语污染：九宫格/CLEAN_GRID/SHOT_TEXT/action_phase/D锁/R1~R3/图STB/七段式  ERROR
  P455 占位与跨格引用：同上/见上/略/TBD/待补                        ERROR
  P456 图片声明：M0/M1 却写「已核验/已看图/图面一致」                  ERROR
  P457 段覆盖：--segments N 时缺段且未列 ⛔ 豁免范围                  ERROR
  P458 交付清单行：缺 `预演故事板：段n~段m ✅ / ⛔未附（理由）`          WARN

退出码：0 = PASS（允许 WARN）· 1 = 有 ERROR · 2 = 用法/读取错误
"""

import json
import os
import re
import sys

SEG_RE = re.compile(r"^#{1,6}\s*\**\s*段\s*(\d+)", re.M)
PANEL_RE = re.compile(r"第\s*(\d+)\s*格\s*[：:]\s*(.*)")
GRID_DECL_RE = re.compile(r"故事板提示词[^\n]*?[（(]\s*(\d+)\s*格\s*[）)]")

TERMS = ["九宫格", "CLEAN_GRID", "SHOT_TEXT", "action_phase", "D锁", "D 锁",
         "R1", "R2", "R3", "图STB", "七段式", "投喂稿"]
PLACEHOLDERS = ["同上", "见上", "省略", "略过", "TBD", "待补", "此处略"]

SIX = {
    "谁在哪": ["在", "站", "坐", "靠", "蹲", "躺", "位于", "门口", "窗边", "桌", "床边", "角落", "中央"],
    "朝哪": ["朝", "面向", "背对", "侧对", "转身", "正对", "侧身"],
    "看哪": ["看", "望", "盯", "视线", "目光", "注视", "抬眼"],
    "做什么": ["走", "跑", "推", "拉", "抓", "握", "抬", "低", "伸", "转", "拿", "放", "撞", "挡",
              "冲", "退", "停", "抱", "扶", "开", "关", "递", "接", "笑", "哭", "皱眉", "咬牙",
              "挥手", "回头", "俯身", "俯下", "起身"],
    "镜头在哪": ["镜头", "机位", "视平线", "俯拍", "仰拍", "俯视", "平视", "近景", "中景", "特写",
               "全景", "远景", "过肩", "正拍", "侧拍"],
    "光从哪来": ["光", "光源", "灯", "月光", "日光", "窗光", "逆光", "侧光", "顶光", "底光",
               "光从", "受光", "背光", "照亮"],
}


def split_segments(text):
    """按 `## 段 N` 切段，返回 [(段号, 标题行, 正文)]。"""
    matches = list(SEG_RE.finditer(text))
    out = []
    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end]
        heading = body.splitlines()[0] if body.splitlines() else ""
        out.append((int(match.group(1)), heading, body))
    return out


def prompt_block(segment_body):
    """取「故事板提示词」标题到下一个标题之间的正文。"""
    idx = segment_body.find("故事板提示词")
    if idx < 0:
        return ""
    rest = segment_body[idx:]
    m = re.search(r"\n#{1,6}\s", rest[len("故事板提示词"):])
    if not m:
        return rest
    cut = len("故事板提示词") + m.start() + 1
    return rest[:cut]


def check_text(text, path="", expected_segments=None, m2=False):
    errors, warns, stats = [], [], {}

    if path and not os.path.basename(path).endswith("-预演故事板.md"):
        warns.append("P450 文件名未以 `-预演故事板.md` 结尾")

    segments = split_segments(text)
    stats["segments"] = len(segments)
    if not segments:
        errors.append("P451 未识别到任何 `## 段 N` 段——附件为空或标题格式不对")
        return errors, warns, stats

    for num, _heading, body in segments:
        tag = f"段{num}"
        for label in ["本段要验什么", "风险提示", "故事板提示词"]:
            if label not in body:
                errors.append(f"P451 {tag} 缺「{label}」")
        if not (("看图" in body and "三点" in body) or "看图时先看这三点" in body):
            errors.append(f"P451 {tag} 缺「看图先看这三点」")

        decl = GRID_DECL_RE.search(body)
        if not decl:
            errors.append(f"P452 {tag} 缺格数声明「故事板提示词（N 格）」")
            declared = None
        else:
            declared = int(decl.group(1))

        panels = PANEL_RE.findall(body)
        stats[f"段{num}_格"] = len(panels)
        if not panels:
            errors.append(f"P452 {tag} 未识别到「第 k 格：」提示词")
        else:
            nums = sorted(int(n) for n, _ in panels)
            if declared is not None and len(panels) != declared:
                errors.append(f"P452 {tag} 声明 {declared} 格，实际 {len(panels)} 格")
            if nums != list(range(1, len(nums) + 1)):
                errors.append(f"P452 {tag} 格号不连续/重复：{nums}")

        for n, panel in panels:
            missing = [key for key, words in SIX.items() if not any(w in panel for w in words)]
            if len(missing) >= 2:
                errors.append(f"P453 {tag} 第{n}格缺六问：{'、'.join(missing)}")
            elif missing:
                warns.append(f"P453 {tag} 第{n}格疑似缺：{missing[0]}")

        block = prompt_block(body)
        for term in TERMS:
            if term in block:
                errors.append(f"P454 {tag} 故事板提示词出现本包术语「{term}」")
        for word in PLACEHOLDERS:
            if word in block:
                errors.append(f"P455 {tag} 故事板提示词出现占位/跨格引用「{word}」")

    if expected_segments:
        present = {n for n, _, _ in segments}
        missing = [n for n in range(1, expected_segments + 1) if n not in present]
        if missing:
            if "⛔" in text and ("未附" in text or "豁免" in text):
                warns.append(f"P457 缺段 {missing}，但存在 ⛔ 豁免说明（请核对范围）")
            else:
                errors.append(f"P457 缺段 {missing}（期望 1~{expected_segments}）且无 ⛔ 豁免说明")

    if not m2:
        for claim in ["已核验", "已看图", "图面一致", "确认过图", "已核对图面"]:
            if claim in text:
                errors.append(f"P456 非 M2 却写「{claim}」——M0/M1 不得声称看过图")

    if "预演故事板" not in text:
        warns.append("P458 缺交付清单行「预演故事板：段n~段m ✅ / ⛔未附（理由）」")

    return errors, warns, stats


def run_self_test():
    good = """# 测试 · 预演故事板

## 段 1 · 雨夜门口，她堵住要走的他
**本段要验什么**：双主体 · 站位不越轴
**风险提示**：两人容易互换左右

### 故事板提示词（3 格）
画一张分镜故事板，3 格，横向排列，9:16，写实电影感，画面中没有任何文字、数字、水印或边框标注。
统一人物设定：阿岚：28岁，短发，黑色风衣，瘦高。陈默：30岁，寸头，灰色夹克，中等身材。
场景：老楼门口，门内暖黄灯，门外冷蓝雨夜。
第 1 格：阿岚站在门框内侧，面朝陈默，目光盯着他的脸，右手抬起来挡在门把前，镜头在两人侧面平视中景，门内暖黄灯光从她背后照过来。
第 2 格：陈默站在门外台阶下，身体朝门口，视线落在她挡门的手上，肩膀微微后撤，镜头在台阶侧前方仰拍中近景，冷蓝路灯光从右上方打下来。
第 3 格：阿岚向前半步，正对陈默，抬眼看他，手仍按在门把上，镜头在门内侧过肩近景，暖光从她左侧漫过来。

### 看图时先看这三点
1. 两人是否始终一左一右，没互换
2. 门内暖光、门外冷光是否分得清
3. 手是否一直挡在门把前
"""
    e, w, s = check_text(good, "测试-预演故事板.md")
    assert not e, e

    bad1 = good.replace("**风险提示**：两人容易互换左右\n", "")
    e, _, _ = check_text(bad1, "测试-预演故事板.md")
    assert any("P451" in x for x in e), e

    bad2 = good.replace("### 故事板提示词（3 格）", "### 故事板提示词（4 格）")
    e, _, _ = check_text(bad2, "测试-预演故事板.md")
    assert any("P452" in x for x in e), e

    bad3 = good.replace("手仍按在门把上", "同上")
    e, _, _ = check_text(bad3, "测试-预演故事板.md")
    assert any("P455" in x for x in e), e

    bad4 = good.replace("门内暖黄灯光从她背后照过来", "九宫格布局")
    e, _, _ = check_text(bad4, "测试-预演故事板.md")
    assert any("P454" in x for x in e), e

    bad5 = good + "\n已核验，与资产图一致。\n"
    e, _, _ = check_text(bad5, "测试-预演故事板.md")
    assert any("P456" in x for x in e), e

    e, _, _ = check_text(good, "测试-预演故事板.md", expected_segments=2)
    assert any("P457" in x for x in e), e

    print("[+] self-test PASSED (6 cases)")


def main(argv):
    if "--self-test" in argv:
        run_self_test()
        return 0

    args = [a for a in argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    path = args[0]

    expected = None
    if "--segments" in argv:
        i = argv.index("--segments")
        if i + 1 < len(argv):
            expected = int(argv[i + 1])

    try:
        with open(path, encoding="utf-8-sig") as handle:
            text = handle.read()
    except (OSError, UnicodeDecodeError) as exc:
        print(f"[-] 读取失败：{exc}")
        return 2

    errors, warns, stats = check_text(text, path, expected, "--m2" in argv)
    print(f"[i] {os.path.basename(path)} · 段 {stats.get('segments', 0)}")
    for warning in warns:
        print("[!] WARN: " + warning)
    for error in errors:
        print("[-] FAIL: " + error)
    if "--json" in argv:
        print(json.dumps({"stats": stats, "errors": errors, "warnings": warns},
                         ensure_ascii=False, indent=2))
    print(f"[+] PASSED P4.5 · FAIL {len(errors)} · WARN {len(warns)}"
          if not errors else f"[-] {len(errors)} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

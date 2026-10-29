#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
compile_feed.py · P4 投喂提示词自动装配编译器（AI 写戏 · 脚本封装）
设计动机：
  在 P4 阶段让大模型手工拼装七段式，极易漏写「Voice 声线锁」「年龄锚/三件套」「CHAR_STATE 偏离替换语」
  「末镜末 1 秒定格收束句」或「M1 素材接线单」。
  本编译器读取 project_state.json，自动将结构化分镜编译为 100% 符合 C1~C30 与六道闸门的七段式投喂稿。
用法：
  python3 scripts/compile_feed.py --state project_state.json [--out feed.md]
  python3 scripts/compile_feed.py --self-test
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import sd_core


def compile_project_to_feed(state):
    locks = state.get("locks", {})
    mode = locks.get("asset_mode", "M1").upper()
    aspect = locks.get("aspect", "16:9")
    style_card = locks.get("style_card", "电影级写实质感")
    wa = state.get("world_anchor", {})
    era = wa.get("era_anchor", "现代")
    receipt = state.get("receipt", {})
    plugins = receipt.get("active_plugins", ["sd-storyboard-engine", "sd-feed-engine"])
    read_refs = receipt.get("read_refs", ["model-adapters.md", "segment-splicing.md"])
    fps = receipt.get("fingerprints", ["【默认镜头策略】"])

    out_lines = [
        f"> 素材形态：{mode}",
        f"> 激活外挂：{' + '.join(plugins)}",
        f"> 已读子库：{' / '.join(read_refs)}",
        f"> 本段调用外挂指纹：{'｜'.join(fps)}",
        "",
    ]

    chars = state.get("characters", {})
    scenes = state.get("scenes", {})
    props = state.get("props", {})
    segments = state.get("segments", [])
    total_segs = max(len(segments), 1)
    used_figs = []

    for idx, seg in enumerate(segments, 1):
        sid = seg.get("seg_id", f"段{idx}")
        seg_type = seg.get("segment_type", "对话戏")
        scn_name = seg.get("scene", "")
        scn = scenes.get(scn_name, {})
        scn_fig = scn.get("fig_no")
        if mode != "M0" and scn_fig:
            used_figs.append((scn_fig, f"场景·{scn_name}", "锁定空间几何、建筑材质与主光源方向", "不控制人物站位与动作"))
            scn_tag = f"@{scn_name}（参考图{scn_fig}）"
        else:
            scn_tag = f"@{scn_name}（{scn.get('coords', '')}；{scn.get('set_states', {}).get('default', '')}；{scn.get('media_layer', '')}）"
        # ★时段光影基准（2026-10-15 · model-adapters §5.0.5b）：场景资产立唯一光影基准，镜行只写增量
        _lt = scn.get("lighting", "")
        if _lt:
            scn_tag += f"；时段光影：{_lt}"

        # 组装【核心人物】（自动注入年龄锚 + 三件套 + Voice 声线锁 + CHAR_STATE 脱离替换语）
        cast_parts = []
        for cname, cinfo in chars.items():
            cfig = cinfo.get("fig_no")
            age = cinfo.get("age_anchor", "")
            body = cinfo.get("body_anchor", "")
            look = cinfo.get("look_3piece", "")
            vlock = cinfo.get("voice_lock", "")
            # 检查本段是否有 CHAR_STATE 脱离声明
            dev_clauses = []
            for _k, st_v in (cinfo.get("char_states") or {}).items():
                item = st_v.get("item", "")
                act = st_v.get("action", "")
                cons = st_v.get("consequence", "")
                if item:
                    dev_clauses.append(
                        f"⚠️资产状态偏离声明：本段{cname}{act}（{cons}），关于「{item}」的佩戴状态以本段提示词为准，覆盖角色参考图"
                    )
            dev_str = "；" + "；".join(dev_clauses) if dev_clauses else ""
            if mode != "M0" and cfig:
                used_figs.append((cfig, f"角色·{cname}", f"锁定{cname}面部五官、头身比与基础服装形制", "不控制本段动作姿态与已声明偏离的配饰状态"))
                cast_parts.append(
                    f"@{cname}（参考图{cfig}，声线锁：{vlock}{dev_str}）"
                )
            else:
                cast_parts.append(
                    f"@{cname}：{age}，{body}，{look}（同一张脸跨镜锁定），声线锁：{vlock}{dev_str}"
                )

        # 组装道具锚点（如有）
        for pname, pinfo in props.items():
            pfig = pinfo.get("fig_no")
            mdesc = pinfo.get("material_desc", "")
            if mode != "M0" and pfig:
                used_figs.append((pfig, f"道具·{pname}", f"锁定{pname}外观形制与材质", "不控制持握人物与运动轨迹"))
                scn_tag += f"；@PRP-{pname}（参考图{pfig}）"
            else:
                scn_tag += f"；@PRP-{pname}（{mdesc}）"

        standing_str = "；".join(seg.get("standing", []))
        shots = seg.get("shots", [])
        shot_lines = []
        for s_i, sh in enumerate(shots):
            no = sh.get("no", s_i + 1)
            st_t = int(sh.get("start", 0))
            ed_t = int(sh.get("end", st_t + 4))
            t_str = f"{st_t // 60:02d}:{st_t % 60:02d}-{ed_t // 60:02d}:{ed_t % 60:02d}"
            spec = sh.get("spec", "中景 · 平视 · 固定")
            act = sh.get("action", "").rstrip("。； ")
            # 遵循 C20m 铁律：镜行正文严禁默认塞入「85mm F1.4极浅景深阴影侧取景（焦平面全程死锁面部无漂移）/ 10-15厘米 / 极细微规律呼吸式微动」等摄影机说明书废话，100% 留给人物与道具纯物理动作
            opt_lock = sh.get("optics_and_camera_lock", "").strip("。； ")
            if opt_lock and opt_lock not in act:
                act += f"；{opt_lock}"
            # 末镜自动注入「前置 0.5 秒收束窗 + 末 1 秒整秒硬定格」标准句
            if s_i == len(shots) - 1 and "定格" not in act and "空镜" not in act:
                settle_t = max(st_t, ed_t - 1.5)
                act += f"；第 {settle_t:g} 秒起运动收束，末 1 秒全体人物保持姿态与站位、动作完全静止、画面定格"
            snd = sh.get("sound", "环境音").rstrip("。 ")
            dlg = sh.get("dialogue", "无").rstrip("。 ")
            shot_lines.append(f"{t_str} [镜头{no}] {spec}。{act}。声音：{snd}。台词：{dlg}。")

        sfx_sum = seg.get("sfx_summary", "自然环境音，对白清晰置顶")
        # 遵循 C19 粉色大象效应铁律：不在【强制禁止项】里重复写具体道具名词（如「禁止同时出现两个眼镜」反会诱发双眼镜），全靠【核心人物】正向替换语锁死
        ban_extra = ""

        out_lines.extend([
            f"## 【投喂单元 {idx}/{total_segs} · {sid}】",
            "```text",
            f"【画幅风格】{aspect} 横屏，{era}，{style_card}，{seg_type}（aspect_ratio={aspect}）",
            f"【场景资产】{scn_tag}",
            f"【核心人物】{'；'.join(cast_parts)}",
            f"【站位声明】{standing_str}",
            "【时间轴分镜】",
            *shot_lines,
            f"【音效】{sfx_sum}",
            f"【强制禁止项】画面：禁止角色面部变形或肢体穿模；文字：无字幕、无水印、无LOGO；音频：禁止背景音乐盖过人声{ban_extra}。",
            "```",
            "",
        ])

    # M1 模式下自动编译《素材接线单》
    if mode == "M1" and used_figs:
        seen_f = set()
        uniq_figs = []
        for item in used_figs:
            if item[0] not in seen_f:
                seen_f.add(item[0])
                uniq_figs.append(item)
        uniq_figs.sort(key=lambda x: x[0])
        out_lines.extend([
            "## 素材接线单（M1 编号占位必备 · 平台挂图指南）",
            "",
            "| 图号 | 对应资产 | 你该挂哪张 | 只控制什么 | 不控制什么 |",
            "|---|---|---|---|---|",
        ])
        for fno, aname, ctrl, no_ctrl in uniq_figs:
            out_lines.append(f"| 图{fno} | {aname} | 挂载 P2 产出的「{aname}」设定图 | {ctrl} | {no_ctrl} |")
        out_lines.append("")

    return "\n".join(out_lines)


def self_test():
    st = sd_core.default_project_state()
    feed_md = compile_project_to_feed(st)
    # 1. 对账校验
    iss_s, wrn_s = sd_core.verify_feed_against_state(feed_md, st)
    assert not iss_s and not wrn_s, f"state verify failed: {iss_s} / {wrn_s}"
    # 2. 跑 validate_prompt.py 与 gate_check.py 实测
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f:
        f.write(feed_md)
        tmp_path = f.name
    try:
        vp_script = os.path.join(SCRIPT_DIR, "validate_prompt.py")
        r1 = subprocess.run(
            [sys.executable, vp_script, tmp_path, "--model", "2.5", "--state", "inline_check"],
            capture_output=True,
            text=True,
        )
        # 用 --model 2.5 直接调用 validate_prompt.py
        r1 = subprocess.run(
            [sys.executable, vp_script, tmp_path, "--model", "2.5"],
            capture_output=True,
            text=True,
        )
        assert r1.returncode == 0, f"validate_prompt failed on compiled feed: {r1.stdout}\n{r1.stderr}"
        gc_script = os.path.join(os.path.dirname( os.path.dirname(SCRIPT_DIR) ), "sd-feed-engine", "scripts", "gate_check.py")
        r2 = subprocess.run(
            [sys.executable, gc_script, tmp_path, "--model", "2.5"],
            capture_output=True,
            text=True,
        )
        assert r2.returncode == 0, f"gate_check failed on compiled feed: {r2.stdout}\n{r2.stderr}"
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    print("[+] compile_feed self-test PASSED (0 FAIL across validate_prompt & gate_check)")
    return 0


def main():
    ap = argparse.ArgumentParser(description="漫剧老李 V7.4.26 P4 投喂自动装配编译器")
    ap.add_argument("--state", help="project_state.json 路径")
    ap.add_argument("--out", help="输出投喂稿 .md 路径（不指定则打印到标准输出）")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        sys.exit(self_test())
    if not args.state:
        ap.print_help()
        sys.exit(2)
    state = json.load(open(args.state, encoding="utf-8"))
    md = compile_project_to_feed(state)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(md)
        print(f"[+] 已编译生成投喂稿：{args.out}")
    else:
        print(md)


if __name__ == "__main__":
    main()

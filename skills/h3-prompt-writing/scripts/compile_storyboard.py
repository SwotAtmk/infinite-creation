#!/usr/bin/env python3
# compile_storyboard.py
# ========================================
# storyboard.json（H3 分镜数据契约）→ MiniMax H3 提示词（Ref2VA 六段式 / FL2VA 三段式）
#
# 本脚本是 h3-prompt-writing 技能的「契约 → 提示词」确定性编译内核，对应
# doc/consistency-plan.md §5.1 桥接脚本的六个模块：
#   StoryboardLoader / RefMapBuilder / LedgerStore / ContinuityCompiler /
#   AnchorResolver / H3PromptRenderer / PromptLinter
#
# 设计边界（重要）：
#   · 只做编译 + 门禁，不提交任何生成任务。执行层（ComfyUI 提交 / 拼帧 / 下载）
#     由外部 runner 负责——本地 `gen_h3_scenes_ref-8b-heretic.py` 只是某一台机器的
#     参考实现，非通用；本脚本产出与机器无关的提示词与段清单，任意 runner 均可消费。
#   · 提示词严格对齐官方指南：references/ref-en.txt（Ref2VA 六段）、
#     references/base-en.txt（FL2VA 三段）。
#   · 最终提示词零指代，且逐段不重复（除显式 allow_repeat 的重复动作镜）
#     → PromptLinter 强制（§8 第 4/5 条、§4.11 原则 2/4）。
#
# 用法：
#   python compile_storyboard.py --storyboard-file storyboard.json --dry-run
#   python compile_storyboard.py --storyboard-file storyboard.json --out segments/
#   python compile_storyboard.py --storyboard-file storyboard.json --check
#   python compile_storyboard.py --prompt-file prompt.txt --dry-run   # 旧流程兜底
# ========================================

import argparse
import json
import math
import re
import sys
from pathlib import Path

SCHEMA_VERSION = "1.0"

# 零指代禁用词（§8 第 4 条 7 类 + 常见同义；中英双查）
BANNED_PHRASES = [
    "上一镜头", "上一个镜头", "前一镜", "前一个镜头", "刚才", "接着", "继续",
    "同上", "同前", "照旧", "依旧", "仍然", "保持原样", "和之前一样", "与之前相同", "与前镜相同",
    "previous shot", "previous segment", "last shot", "the shot before",
    "same as before", "as before", "continue from", "continues from",
    "carry over from the previous", "as in the previous", "refer to the previous",
]

# 结尾固定「保留 / 规避」句（§6.2：资产不进成片 + 无字幕/logo）
PRESERVE_AVOID = (
    "Frame edges stay razor-sharp with no added softening, fabric weave and individual hair "
    "strands remain resolved, and the image contains no captions, no logos, no watermarks, and "
    "no on-screen text of any kind. Character and scene reference sheets are identity and space "
    "references only; their grid layout and side-by-side views never appear in the video."
)

TIME_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*s\s*$")


# ─────────────────────────────────────────────
# 0. 工具函数
# ─────────────────────────────────────────────

def read_file(path):
    """读取文本文件，自动检测编码（与仓库其它技能脚本一致）。"""
    for enc in ("utf-8", "utf-8-sig", "gbk", "gb2312", "big5"):
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, LookupError):
            continue
    raise ValueError("无法解码文件：%s（请转为 utf-8 或 gbk）" % path)


def _safe_print(msg):
    """安全打印：规避 Windows 终端 GBK/CP936 不支持某些字符的问题。"""
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("ascii", errors="replace").decode("ascii"))


def err(rule, msg):
    return {"level": "error", "rule": rule, "msg": msg}


def warn(rule, msg):
    return {"level": "warn", "rule": rule, "msg": msg}


def present_labels(sb, shot):
    """本镜出场角色的标签顺序（决定 <Subject N> 序号）。优先取 positions 键序，否则取 refs 中的角色。"""
    pos = shot.get("positions") or {}
    labels = [l for l in pos.keys() if l in (sb.get("characters") or {})]
    if labels:
        return labels
    refs = shot.get("refs") or {}
    return [l for l in refs.keys() if l in (sb.get("characters") or {})]


# ─────────────────────────────────────────────
# 1. StoryboardLoader
# ─────────────────────────────────────────────

class StoryboardLoader:
    """读 storyboard.json（utf-8/gbk 兼容）并做最基础的结构校验。"""

    def load(self, path):
        sb = json.loads(read_file(path))
        if not isinstance(sb, dict):
            raise ValueError("storyboard 根节点必须是对象")
        return sb

    def validate(self, sb):
        issues = []
        for key in ("art_style_prefix", "characters", "scenes", "shots"):
            if key not in sb:
                issues.append(err("missing_top_field", "缺少顶层字段：%s" % key))
        shots = sb.get("shots") or []
        if not shots:
            issues.append(err("no_shots", "shots 为空"))
        scenes = sb.get("scenes") or {}
        seen_ids = set()
        for i, shot in enumerate(shots):
            for key in ("id", "scene", "duration", "beats"):
                if key not in shot:
                    issues.append(err("missing_shot_field", "shots[%d] 缺少字段：%s" % (i, key)))
            sid = shot.get("id")
            if sid in seen_ids:
                issues.append(err("duplicate_shot_id", "重复 shot id：%s" % sid))
            seen_ids.add(sid)
            if shot.get("scene") and shot["scene"] not in scenes:
                issues.append(err("unknown_scene", "shots[%d].scene 未在 scenes 定义：%s" % (i, shot["scene"])))
            refs = shot.get("refs") or {}
            for label, p in refs.items():
                if label.startswith("@") and label not in (sb.get("characters") or {}):
                    issues.append(err("unknown_character", "shots[%d].refs 引用了未定义角色：%s" % (i, label)))
                if label.startswith("#") and label not in scenes:
                    issues.append(err("unknown_scene", "shots[%d].refs 引用了未定义场景：%s" % (i, label)))
        return issues


# ─────────────────────────────────────────────
# 2. RefMapBuilder
# ─────────────────────────────────────────────

class RefMapBuilder:
    """每 shot 重建参考绑定，禁止跨段继承（§5.1）。refs 的键序即上传序 → <Picture N>。"""

    def build(self, sb, shot, kind):
        refs = shot.get("refs") or {}
        if kind == "fl2va":
            # fl2va 节点无 ref 端口：即使契约误填也不注册，交 PromptLinter 报警
            return {"ref_images": [], "duties": {}, "label_to_picture": {}}
        images, duties, label_to_picture = [], {}, {}
        for label, path in refs.items():
            if not path:
                continue
            n = len(images) + 1
            label_to_picture[label] = n
            images.append(path)
            if label.startswith("#"):
                duty = (sb.get("scenes") or {}).get(label, {}).get("ref_role", "空间")
            else:
                duty = (sb.get("characters") or {}).get(label, {}).get("ref_role", "身份")
            duties[path] = {"duty": duty, "version": "v1"}
        return {"ref_images": images, "duties": duties, "label_to_picture": label_to_picture}

    def check_refs_exist(self, ref_map, ref_root):
        issues = []
        if not ref_root:
            return issues
        for p in ref_map["ref_images"]:
            if not (Path(ref_root) / p).exists():
                issues.append(warn("ref_missing", "参考图不存在（--strict-refs 时判错）：%s" % p))
        return issues


# ─────────────────────────────────────────────
# 3. ContinuityCompiler + AnchorResolver
# ─────────────────────────────────────────────

class AnchorResolver:
    """世界位置 × 画面位置双写（§4.11 原则 3）：把站位/光照展开成显式英文文字。"""

    def placement(self, sb, shot, subj_index, labelled):
        parts = []
        for label in present_labels(sb, shot):
            c = (sb.get("characters") or {}).get(label)
            if not c:
                continue
            pos = (shot.get("positions") or {}).get(label) or {}
            static = ", ".join(c.get("static_features") or [])
            dyn = ", ".join(c.get("dynamic_features") or [])
            if labelled:
                who = "<Subject %s>, %s" % (subj_index.get(label), c.get("name_en", label))
            else:
                who = c.get("name_en", label)
            seg = "On the %s, %s with %s, %s" % (
                pos.get("screen_pos", "left of the frame"),
                who,
                static,
                pos.get("pose", "stands still"),
            )
            if dyn:
                seg += ", wearing %s" % dyn
            parts.append(seg + ".")
        return " ".join(parts)


class ContinuityCompiler:
    """零指代展开：校验并提示跨镜状态由 ledger 结算，而非在提示词里写「同上」（§6.5）。"""

    def continuity_note(self, sb, shot, prev_shot):
        """生成人读的承接说明（不进入 H3 提示词）。"""
        if not prev_shot:
            return "开场镜：无前序状态"
        return "承接 %s 的尾帧状态（已展开为零指代全物理描述，不写「同上」）" % prev_shot.get("id")


# ─────────────────────────────────────────────
# 4. H3PromptRenderer
# ─────────────────────────────────────────────

class H3PromptRenderer:
    """契约 → H3 prompt（字段来源见 §6.6）。提示词正文全英文。"""

    def __init__(self, sb):
        self.sb = sb

    # ---- 共用片段 ----

    def _beats_text(self, shot):
        out = []
        for b in shot.get("beats") or []:
            a = (b.get("action") or "").strip()
            if a:
                out.append(a)
        return " ".join(out)

    def _soundscape(self, shot):
        if shot.get("overall_soundscape"):
            return shot["overall_soundscape"].strip()
        sounds = []
        for b in shot.get("beats") or []:
            s = (b.get("sound") or "").strip()
            if s and s not in sounds:
                sounds.append(s)
        if not sounds:
            return "N/A"
        return " ".join(s[0].upper() + s[1:] + ("" if s.endswith(".") else ".") for s in sounds)

    def _ndm(self, shot):
        return (shot.get("non_diegetic_music") or "N/A").strip()

    def _preserve_avoid(self, shot):
        return (shot.get("preserve_avoid") or PRESERVE_AVOID).strip()

    @staticmethod
    def _cap(text):
        text = (text or "").strip()
        return text[:1].upper() + text[1:] if text else text

    def _style(self):
        return (self.sb.get("art_style_prefix") or "").strip()

    # ---- Ref2VA 六段 ----

    def _char_def(self, c, n, picture_n):
        static = ", ".join(c.get("static_features") or [])
        dyn = ", ".join(c.get("dynamic_features") or [])
        s = "<Subject %d> is %s" % (n, c.get("name_en", "the character"))
        if picture_n:
            s += " in <Picture %d>" % picture_n
        if static:
            s += ", with %s" % static
        if dyn:
            s += ", wearing %s" % dyn
        return s + "."

    def _scene_def(self, label, n, picture_by_label):
        s = (self.sb.get("scenes") or {}).get(label) or {}
        static = ", ".join(s.get("static_features") or [])
        shared = [lab for lab in (s.get("shared_by") or []) if lab in picture_by_label]
        shared_txt = ""
        if len(shared) >= 2:
            shared_txt = " shared by " + " and ".join("<Picture %d>" % picture_by_label[l] for l in shared)
        elif len(shared) == 1:
            shared_txt = " shared by <Picture %d>" % picture_by_label[shared[0]]
        line = "<Subject %d> is %s%s" % (n, s.get("name_en", label), shared_txt)
        if static:
            line += ", %s" % static
        return line + "."

    def subject_index(self, shot, ref_map):
        """角色按出场序编 <Subject N>，其后是场景；同时返回 <Picture N> 映射。"""
        idx, n = {}, 0
        for label in present_labels(self.sb, shot):
            n += 1
            idx[label] = n
        scene_label = shot.get("scene")
        if scene_label and scene_label in (self.sb.get("scenes") or {}):
            n += 1
            idx[scene_label] = n
        return idx, ref_map.get("label_to_picture", {})

    def _retention_lines(self, shot, subj_index, shot_number):
        lines = []
        for label, n in subj_index.items():
            if label in (self.sb.get("characters") or {}):
                c = self.sb["characters"][label]
                detail = c.get("retention_en")
                if not detail:
                    dnc = ", ".join(c.get("do_not_change") or [])
                    detail = (dnc + " are retained") if dnc else "its defined role is fully preserved"
            else:
                s = self.sb["scenes"][label]
                detail = s.get("retention_en")
                if not detail:
                    detail = ", ".join(s.get("static_features") or []) + " are retained"
            detail = detail.strip().rstrip(".")
            lines.append("<Subject %d> (appears in [Shot %d]): fully_preserved - %s." % (n, shot_number, detail))
        return lines

    def _body_common(self, shot, subj_index, labelled, resolver):
        parts = []
        parts.append(self._style())
        present = present_labels(self.sb, shot)
        scene_label = shot.get("scene")
        scene = (self.sb.get("scenes") or {}).get(scene_label) or {}
        if labelled:
            subj_phrase = " and ".join("<Subject %s>" % subj_index[l] for l in present if l in subj_index)
            scene_phrase = "<Subject %s>" % subj_index[scene_label] if scene_label in subj_index else "the backdrop"
            tag = "[Static shot] " if (shot.get("camera_move") or "").lower() == "static" else ""
            parts.append("[Shot 1] %s%s, %s, frames %s standing against %s." % (
                tag, self._cap(shot.get("shot_size_en", "a locked-off shot")),
                shot.get("angle_en", "eye-level"), subj_phrase or "the subjects", scene_phrase))
        else:
            names = " and ".join(self.sb["characters"][l].get("name_en", l) for l in present if l in self.sb.get("characters", {}))
            parts.append("[Shot 1] %s, %s, holds on %s against %s." % (
                self._cap(shot.get("shot_size_en", "a locked-off shot")),
                shot.get("angle_en", "eye-level"),
                names or "the subjects",
                scene.get("name_en", "the backdrop")))
        parts.append(resolver.placement(self.sb, shot, subj_index, labelled))
        parts.append((shot.get("lighting_en") or "").strip())
        parts.append((shot.get("camera_move_en") or "").strip())
        parts.append(self._beats_text(shot))
        parts.append(self._preserve_avoid(shot))
        return " ".join(p for p in parts if p)

    def render_ref2va(self, shot, shot_number, ref_map, resolver):
        subj_index, picture_by_label = self.subject_index(shot, ref_map)
        def_lines = []
        for label in present_labels(self.sb, shot):
            c = self.sb["characters"].get(label)
            if c:
                def_lines.append(self._char_def(c, subj_index[label], picture_by_label.get(label)))
        scene_label = shot.get("scene")
        if scene_label in subj_index:
            def_lines.append(self._scene_def(scene_label, subj_index[scene_label], picture_by_label))
        summary = (shot.get("shot_purpose") or "").strip()
        if not summary:
            summary = "The target video presents the subjects described by their reference assets in a single continuous shot."
        blocks = [
            "subject_definitions:\n" + "\n".join(def_lines),
            "summary:\n[reference generation] " + summary,
            "retention_analysis:\n" + "\n".join(self._retention_lines(shot, subj_index, shot_number)),
            "detailed_description:\n" + self._body_common(shot, subj_index, True, resolver),
            "overall_soundscape: " + self._soundscape(shot),
            "non_diegetic_music: " + self._ndm(shot),
        ]
        return "\n\n".join(blocks)

    def render_fl2va(self, shot, shot_number, resolver):
        subj_index, _ = self.subject_index(shot, {"label_to_picture": {}})
        blocks = [
            "integrated_multimodal_description: " + self._body_common(shot, subj_index, False, resolver),
            "overall_soundscape: " + self._soundscape(shot),
            "non_diegetic_music: " + self._ndm(shot),
        ]
        return "\n\n".join(blocks)


# ─────────────────────────────────────────────
# 5. PromptLinter（强制门禁）
# ─────────────────────────────────────────────

class PromptLinter:
    """编译后校验：任 error → 编译失败（§8）。"""

    def check_shot(self, sb, shot, prompt, kind, ref_map, action_sigs, shot_number, ref_root):
        issues = []
        # ① 零指代禁用词
        low = prompt.lower()
        for phrase in BANNED_PHRASES:
            if phrase.lower() in low:
                issues.append(err("banned_phrase", "%s 出现禁用指代词：%r" % (shot.get("id"), phrase)))
        # ② 时长预算
        issues += self._check_duration(shot)
        # ③ 字段完整性 + §6.6 硬约束①②
        issues += self._check_fields(sb, shot, kind, prompt)
        # ④ 运镜可执行性
        issues += self._check_camera(shot)
        # ⑤ 逐段不重复（用户强调：每段提示词不得重复，除非本就做重复动作）
        sig = action_signature(shot)
        if sig and sig in action_sigs and not shot.get("allow_repeat"):
            issues.append(err("duplicate_action", "%s 与另一镜动作完全重复（若为重复动作镜请设 allow_repeat=true）" % shot.get("id")))
        # ⑥ 参考图存在性
        issues += RefMapBuilder().check_refs_exist(ref_map, ref_root)
        return issues

    def _check_duration(self, shot):
        issues = []
        dur = float(shot.get("duration") or 0)
        intervals = []
        for i, b in enumerate(shot.get("beats") or []):
            m = TIME_RE.match(str(b.get("time", "")))
            if not m:
                issues.append(err("beat_time_format", "%s beats[%d].time 不符合 \"起-止s\"：%r" % (shot.get("id"), i, b.get("time"))))
                continue
            a, bb = float(m.group(1)), float(m.group(2))
            if bb <= a:
                issues.append(err("beat_time_order", "%s beats[%d] 结束≤开始" % (shot.get("id"), i)))
            intervals.append((a, bb))
        if not intervals:
            return issues
        intervals.sort()
        if abs(intervals[0][0]) > 1e-6:
            issues.append(err("duration_start", "%s beats 未从 0 开始（首个起点 %s）" % (shot.get("id"), intervals[0][0])))
        if abs(intervals[-1][1] - dur) > 1e-6:
            issues.append(err("duration_end", "%s beats 未覆盖 duration=%s（末个终点 %s）" % (shot.get("id"), dur, intervals[-1][1])))
        for (a1, b1), (a2, b2) in zip(intervals, intervals[1:]):
            if a2 > b1 + 1e-6:
                issues.append(err("duration_gap", "%s beats 之间有空洞 %s-%ss" % (shot.get("id"), b1, a2)))
            elif a2 < b1 - 1e-6:
                issues.append(err("duration_overlap", "%s beats 重叠 %s-%ss" % (shot.get("id"), a2, b1)))
        return issues

    def _check_fields(self, sb, shot, kind, prompt):
        issues = []
        sid = shot.get("id")
        refs = shot.get("refs") or {}
        has_ref = any(v for v in refs.values())
        if kind == "ref2va" and not has_ref:
            issues.append(err("ref2va_requires_refs", "%s 为 Ref2VA 段但 refs 为空（D11：每段必有参考图）" % sid))
        if kind == "fl2va" and has_ref:
            issues.append(warn("fl2va_refs_ignored", "%s 为 FL2VA 段，无 ref 端口，refs 已忽略（应留空）" % sid))

        positions = shot.get("positions") or {}
        if not positions:
            issues.append(err("missing_positions", "%s 缺少 positions（画面位置）" % sid))
        if not (shot.get("world_pos") or {}):
            issues.append(err("missing_world_pos", "%s 缺少 world_pos（世界位置，零指代要求写绝对位置）" % sid))
        if not shot.get("axis_en"):
            issues.append(err("missing_axis", "%s 缺少 axis_en（180° 轴线）" % sid))
        if not shot.get("first_frame_hard"):
            issues.append(err("missing_first_frame_hard", "%s 缺少 first_frame_hard（首帧硬描述）" % sid))
        if not shot.get("last_frame_hard"):
            issues.append(warn("missing_last_frame_hard", "%s 缺少 last_frame_hard（尾帧硬描述，下一段承接依据）" % sid))
        if not any(("facing" in p or "view_target" in p) for p in positions.values()):
            issues.append(err("missing_view_target", "%s positions 未提供 facing/view_target（视线）" % sid))

        light = (shot.get("lighting_en") or "").strip()
        if not light:
            issues.append(err("missing_lighting", "%s 缺少 lighting_en（光照基线）" % sid))
        elif light not in prompt:
            issues.append(err("lighting_not_in_prompt", "%s lighting_en 未进入提示词（站位/光照须文字重申）" % sid))
        return issues

    def _check_camera(self, shot):
        issues = []
        sid = shot.get("id")
        cm = (shot.get("camera_move") or "").strip()
        cmen = (shot.get("camera_move_en") or "").strip()
        if not cm:
            issues.append(err("missing_camera_move", "%s 缺少 camera_move" % sid))
        if not cmen:
            issues.append(err("missing_camera_move_en", "%s 缺少 camera_move_en（运镜英文原句）" % sid))
        elif cm and cm.lower() != "static":
            low = cmen.lower()
            has_start = bool(re.search(r"\b(from|starts?|begins?|starting)\b", low))
            has_end = bool(re.search(r"\b(to|until|ends?|stopping|stops?)\b", low))
            if not (has_start and has_end):
                issues.append(warn("camera_not_executable", "%s 运镜 %s 未写清起点/终点/跟随目标/停止原因，判定不可执行" % (sid, cm)))
        return issues

    def check_film(self, sb):
        """跨镜软校验：连续 ≥3 镜同景别+同角度+固定机位 → 镜头语言重复风险。"""
        issues = []
        shots = sb.get("shots") or []
        run = []
        for shot in shots:
            key = (shot.get("shot_size_en"), shot.get("angle_en"), (shot.get("camera_move") or "").lower())
            if key == (None, None, ""):
                run = []
                continue
            if run and run[-1][0] == key:
                run[-1][1].append(shot.get("id"))
            else:
                run.append((key, [shot.get("id")]))
        for key, ids in run:
            if len(ids) >= 3 and key[2] == "static":
                issues.append(warn("shot_language_repeat", "连续 %d 镜同景别+同角度+固定机位：%s（镜头语言重复风险）" % (len(ids), ", ".join(ids))))
        return issues


def action_signature(shot):
    """动作指纹：beats[].action 归一化拼接，用于「逐段不重复」判定。"""
    text = " ".join((b.get("action") or "") for b in (shot.get("beats") or []))
    return re.sub(r"\W+", " ", text.lower()).strip()


# ─────────────────────────────────────────────
# 6. LedgerStore（连续性账本，§6.5）
# ─────────────────────────────────────────────

class LedgerStore:
    def build(self, sb, units):
        shots = {s.get("id"): s for s in (sb.get("shots") or [])}
        ledger = {}
        for shot in sb.get("shots") or []:
            sid = shot.get("id")
            entry = {"start": {}, "end": {}, "has_frames": {"first": True, "last": True}}
            for label, pos in (shot.get("positions") or {}).items():
                entry["start"][label] = {
                    "world_pos": (shot.get("world_pos") or {}).get(label),
                    "screen_pos": pos.get("screen_pos"),
                    "facing": pos.get("facing") or pos.get("view_target"),
                    "axis_side": pos.get("axis_side"),
                    "held": pos.get("held", []),
                    "light": shot.get("lighting_en"),
                    "phase": shot.get("first_frame_hard"),
                }
                entry["end"][label] = {
                    "world_pos": (shot.get("world_pos") or {}).get(label),
                    "screen_pos": pos.get("screen_pos"),
                    "phase": shot.get("last_frame_hard"),
                }
            ledger[sid] = entry
        return ledger


# ─────────────────────────────────────────────
# 7. UnitPlanner（段计划：整片首段 Ref2VA，其余 FL2VA；超长自动拆分）
# ─────────────────────────────────────────────

class UnitPlanner:
    def plan(self, sb, max_duration):
        units = []
        film_first = True
        for i, shot in enumerate(sb.get("shots") or []):
            dur = float(shot.get("duration") or 0)
            n = int(math.ceil(dur / max_duration - 1e-9)) if max_duration and max_duration > 0 else 1
            n = max(1, n)
            for k in range(n):
                units.append({
                    "index": len(units),
                    "shot_id": shot.get("id"),
                    "shot_index": i,
                    "unit_index": k,
                    "sub_units": n,
                    "duration": round(dur / n, 3),
                    "kind": "ref2va" if film_first else "fl2va",
                })
                film_first = False
        return units


# ─────────────────────────────────────────────
# 8. main
# ─────────────────────────────────────────────

def split_prompt_file(text):
    """旧流程兜底：prompt.txt 以 '###' 行分块，每块一段。"""
    blocks, cur = [], []
    for line in text.splitlines():
        if line.strip().startswith("###"):
            if "".join(cur).strip():
                blocks.append("\n".join(cur).strip())
            cur = []
        else:
            cur.append(line)
    if "".join(cur).strip():
        blocks.append("\n".join(cur).strip())
    return blocks


def build_parser():
    p = argparse.ArgumentParser(
        description="storyboard.json → MiniMax H3 提示词（Ref2VA 六段 / FL2VA 三段），带零指代与逐段不重复门禁。")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--storyboard-file", help="分镜契约 storyboard.json 路径")
    src.add_argument("--prompt-file", help="旧流程兜底：直接读 prompt.txt（按 '###' 分块，仅做门禁与转发）")
    p.add_argument("--out", help="写出目录：每段一个 .prompt.txt + segments.json + continuity-ledger.json")
    p.add_argument("--dry-run", action="store_true", help="打印每段 ref_map / 站位 / 提示词，不写文件")
    p.add_argument("--check", action="store_true", help="只做门禁校验，不打印完整提示词")
    p.add_argument("--max-duration", type=float, default=None, help="单段物理时长上限（秒），默认取契约 video.default_max_duration 或 5.0")
    p.add_argument("--ref-root", default=None, help="参考图相对路径的解析根目录（默认取契约文件所在目录）")
    p.add_argument("--strict-refs", action="store_true", help="参考图缺失判 error（默认仅 warn）")
    p.add_argument("--json", action="store_true", help="以 JSON 输出编译结果（供 runner 消费）")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    all_issues = []
    payload = {"mode": None, "units": []}

    if args.prompt_file:
        # ---- 旧流程兜底：仅门禁 + 转发 ----
        text = read_file(args.prompt_file)
        blocks = split_prompt_file(text)
        payload["mode"] = "prompt-file"
        for i, block in enumerate(blocks):
            issues = []
            low = block.lower()
            for phrase in BANNED_PHRASES:
                if phrase.lower() in low:
                    issues.append(err("banned_phrase", "块 %d 出现禁用指代词：%r" % (i + 1, phrase)))
            payload["units"].append({"index": i, "kind": ("ref2va" if "subject_definitions" in block else "fl2va"),
                                     "prompt": block, "issues": issues})
            all_issues += issues
        mode = "prompt-file"
    else:
        # ---- 契约编译 ----
        loader = StoryboardLoader()
        sb = loader.load(args.storyboard_file)
        struct_issues = loader.validate(sb)
        all_issues += struct_issues
        payload["mode"] = "storyboard"
        max_duration = args.max_duration
        if max_duration is None:
            max_duration = float((sb.get("video") or {}).get("default_max_duration") or 5.0)
        ref_root = args.ref_root or str(Path(args.storyboard_file).resolve().parent)

        units = UnitPlanner().plan(sb, max_duration)
        renderer = H3PromptRenderer(sb)
        resolver = AnchorResolver()
        linter = PromptLinter()
        ref_builder = RefMapBuilder()
        shots = sb.get("shots") or []
        action_sigs = set()

        all_issues += linter.check_film(sb)

        for u in units:
            shot = shots[u["shot_index"]]
            kind = u["kind"]
            ref_map = ref_builder.build(sb, shot, kind)
            if kind == "ref2va":
                prompt = renderer.render_ref2va(shot, u["shot_index"] + 1, ref_map, resolver)
            else:
                prompt = renderer.render_fl2va(shot, u["shot_index"] + 1, resolver)
            sig = action_signature(shot)
            issues = linter.check_shot(sb, shot, prompt, kind, ref_map, action_sigs, u["shot_index"] + 1, "")
            if args.strict_refs:
                for extra in ref_builder.check_refs_exist(ref_map, ref_root):
                    issues.append(err("ref_missing", extra["msg"]) if extra["level"] == "warn" else extra)
            if u["sub_units"] > 1:
                issues.append(warn("auto_split_repeats_action",
                                   "%s 超长被拆成 %d 段，子段将重复同一动作/提示词（硬件限制所致，如非本意请缩短 duration）"
                                   % (u["shot_id"], u["sub_units"])))
            all_issues += issues
            if sig:
                action_sigs.add(sig)
            payload["units"].append({
                "index": u["index"], "shot_id": u["shot_id"], "kind": kind,
                "duration": u["duration"], "sub_units": u["sub_units"], "unit_index": u["unit_index"],
                "ref_images": ref_map["ref_images"], "duties": ref_map["duties"],
                "prompt": prompt, "issues": issues,
            })
        payload["ledger"] = LedgerStore().build(sb, units)
        mode = "storyboard"

    errors = [i for i in all_issues if i["level"] == "error"]
    warns = [i for i in all_issues if i["level"] == "warn"]

    # ---- 输出 ----
    if args.json:
        payload["issues"] = all_issues
        _safe_print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        _safe_print("== compile_storyboard: 模式=%s，段数=%d，error=%d，warn=%d ==" % (
            payload["mode"], len(payload["units"]), len(errors), len(warns)))
        for u in payload["units"]:
            if not args.check:
                head = "# 段 %d | %s | %s | %ss" % (u["index"], u.get("shot_id", "-"), u["kind"], u.get("duration", "-"))
                if u.get("ref_images"):
                    head += " | refs=" + ",".join(u["ref_images"])
                _safe_print("\n" + head)
                if args.dry_run or args.out:
                    _safe_print("-" * 60)
                    _safe_print(u["prompt"])
        if all_issues:
            _safe_print("\n-- 门禁报告 --")
            for i in all_issues:
                _safe_print("[%s] %s: %s" % (i["level"].upper(), i["rule"], i["msg"]))
        else:
            _safe_print("\n门禁通过：零指代 / 时长预算 / 字段完整性 / 逐段不重复 全部合规。")

    # ---- 落盘 ----
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        manifest = []
        for u in payload["units"]:
            name = u.get("shot_id") or ("seg%02d" % u["index"])
            if u.get("sub_units", 1) > 1:
                name += "_u%d" % u["unit_index"] if "unit_index" in u else "_%d" % u["index"]
            fn = "%02d_%s.prompt.txt" % (u["index"], name)
            (out / fn).write_text(u["prompt"], encoding="utf-8")
            manifest.append({
                "index": u["index"], "shot_id": u.get("shot_id"), "kind": u["kind"],
                "duration": u.get("duration"), "ref_images": u.get("ref_images", []),
                "prompt_file": fn,
            })
        (out / "segments.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        if payload.get("ledger") is not None:
            (out / "continuity-ledger.json").write_text(
                json.dumps(payload["ledger"], ensure_ascii=False, indent=2), encoding="utf-8")
        _safe_print("\n已写出：%s（%d 段 + segments.json + continuity-ledger.json）" % (out, len(manifest)))

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())

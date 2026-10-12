#!/usr/bin/env python3
# gen_storyboard_llm.py
# ========================================
# 小说正文 → storyboard.json（H3 分镜数据契约），由本地 LLM 起草 + 编译器门禁闭环。
#
# 定位：契约编译链的**上游**。compile_storyboard.py 把 storyboard.json 编译成 H3 提示词；
#       本脚本负责把小说/剧本正文变成那份 storyboard.json。
#       分工遵循 doc/consistency-plan.md §4.11：**LLM 负责写，脚本负责闸门**——
#       生成后立即调用 compile_storyboard.py --json 做门禁，把 error 回灌给 LLM 重写，
#       直至零 error 或重试用尽。
#
# 只依赖标准库（urllib），对接任意 OpenAI 兼容端点（本地 llama.cpp router / 云端均可）。
# 无资产的正文（纯文字起片）会把每镜 refs 生成空对象 → 编译器首段自动降级为 T2VA。
#
# 用法：
#   # 1) 小说 → 契约（本地 LLM，默认 http://127.0.0.1:1234/v1）
#   python gen_storyboard_llm.py --novel-file novel.md --out storyboard.json
#   # 2) 契约 → 提示词（确定性编译 + 门禁）
#   python compile_storyboard.py --storyboard-file storyboard.json --out segments/
#
#   # 只看提示词不发请求 / 换云端端点：
#   python gen_storyboard_llm.py --novel-file novel.md --out sb.json --dry-run
#   python gen_storyboard_llm.py --novel-file novel.md --out sb.json \
#       --base-url https://api.example.com/v1 --model some-model --api-key sk-xxx
# ========================================

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REFERENCES = HERE.parent / "references"

DEFAULT_BASE_URL = os.environ.get("H3_LLM_BASE_URL", "http://127.0.0.1:1234/v1")
DEFAULT_MODEL = os.environ.get("H3_LLM_MODEL", "Huihui-Qwen3.8-27B-abliterated-GGUF")
DEFAULT_API_KEY = os.environ.get("H3_LLM_API_KEY", "123456")

# 与 compile_storyboard.py 保持同一套零指代禁用词（这里是提示 LLM 主动规避的清单）
BANNED_HINT = (
    "previous shot, previous segment, last shot, the shot before, same as before, as before, "
    "continue from, continues from, carry over from the previous, as in the previous, refer to the previous, "
    "上一镜头, 上一个镜头, 前一镜, 前一个镜头, 刚才, 接着, 继续, 同上, 同前, 照旧, 依旧, 仍然, 保持原样, "
    "和之前一样, 与之前相同, 与前镜相同"
)


# ─────────────────────────────────────────────
# 0. 工具
# ─────────────────────────────────────────────

def read_text(path):
    for enc in ("utf-8", "utf-8-sig", "gbk", "gb2312", "big5"):
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, LookupError):
            continue
    raise ValueError("无法解码文件：%s（请转为 utf-8 或 gbk）" % path)


def safe_print(msg=""):
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("ascii", errors="replace").decode("ascii"))


def extract_json(text):
    """从模型输出里抠出第一个完整 JSON 对象：兼容 ```json 围栏与前后噪声。"""
    if not text:
        raise ValueError("模型返回空内容")
    s = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", s, re.S)
    if fence:
        s = fence.group(1).strip()
    start = s.find("{")
    if start < 0:
        raise ValueError("输出中找不到 JSON 对象")
    depth, in_str, esc = 0, False, False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(s[start:i + 1])
    raise ValueError("JSON 括号不闭合（可能被 max_tokens 截断）")


# ─────────────────────────────────────────────
# 1. LLM 客户端（OpenAI 兼容）
# ─────────────────────────────────────────────

class LLMClient:
    def __init__(self, base_url, model, api_key, timeout, temperature, top_p,
                 max_tokens, think=False, response_format=None):
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.temperature = temperature
        self.top_p = top_p
        self.max_tokens = max_tokens
        self.think = think
        self.response_format = response_format

    def chat(self, messages):
        body = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "top_p": self.top_p,
            "max_tokens": self.max_tokens,
            # llama.cpp / vLLM 通用：关掉 Qwen3 系思考，直接产出正文（--think 打开）
            "chat_template_kwargs": {"enable_thinking": bool(self.think)},
        }
        if self.response_format:
            body["response_format"] = self.response_format
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        if self.api_key:
            req.add_header("Authorization", "Bearer %s" % self.api_key)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError("HTTP %s: %s" % (e.code, detail))
        except urllib.error.URLError as e:
            raise RuntimeError("连接失败（LLM 未启动？%s）：%s" % (self.url, e.reason))
        choices = payload.get("choices") or []
        if not choices:
            raise RuntimeError("响应无 choices：%s" % json.dumps(payload, ensure_ascii=False)[:500])
        msg = choices[0].get("message") or {}
        content = msg.get("content") or ""
        # 少数实现把思维链放在 reasoning_content：正文为空时逐字剥离
        if not content.strip() and msg.get("reasoning_content"):
            content = msg["reasoning_content"]
        return content


# ─────────────────────────────────────────────
# 2. 提示词构造
# ─────────────────────────────────────────────

def load_reference(name):
    p = REFERENCES / name
    return read_text(p) if p.exists() else ""


def build_system_prompt(schema_text, example_text, shots_hint, target_total, seg_max):
    rules = """You are a senior storyboard director for MiniMax H3 text-to-video. Read the user's novel chapter and output ONE storyboard.json that conforms to the H3 storyboard contract. You design the shots; a deterministic compiler will later turn them into H3 prompts.

OUTPUT CONTRACT
- Output ONLY a single JSON object. No markdown fences, no commentary, no prose before or after.
- Top-level keys: schema_version, title, art_style_prefix, video, characters, scenes, shots.
- Every value that reaches an H3 prompt MUST be English: art_style_prefix, name_en, static_features, dynamic_features, do_not_change, retention_en, shot_size_en, angle_en, camera_move_en, world_pos, axis_en, positions.*, lighting_en, beats[].action/camera/sound/handoff, first_frame_hard, last_frame_hard, overall_soundscape, non_diegetic_music, shot_purpose, scene static_features/slugline/anchors.
- Human-only fields may be Chinese: title, cut_reason, continuity_risk.

characters  (object, key = "@" + Chinese character name)
  name_en (English noun phrase, e.g. "the eleven-year-old boy"), static_features (>=3 English phrases: face, hair, skin, build), dynamic_features (>=3 English phrases: clothing, shoes, carried items), do_not_change (English phrases), ref_role ("身份"), retention_en (one English clause listing what must be retained).
  IMPORTANT: there are NO reference images yet, so DO NOT emit ref_front.

scenes  (object, key = "#" + Chinese scene name)
  name_en, static_features (>=3 English phrases of the fixed space), shared_by (character labels present), ref_role ("空间"), ref_wide (null), slugline ("EXT./INT. 地点 - 时段"), anchors (stable landmarks with a role, e.g. "the rusted gate = the only entrance at the frame's left edge"), retention_en.

shots  (array, in story order; high-quality, faithful adaptation)
  id: "S01_01", "S01_02", ... (strictly increasing, S01 = scene 1)
  scene: one of the defined "#" labels
  duration: number, 3 to %(seg_max)s seconds (never exceed %(seg_max)s)
  shot_size_en: e.g. "a locked-off medium shot"; angle_en: e.g. "eye-level, slightly high, from the left"
  camera_move: one of static / push_in / pull_out / pan_left / pan_right / truck_left / truck_right / tilt_up / tilt_down / arc / tracking / pedestal_up / pedestal_down
  camera_move_en: full English sentence; if not static, state the start, the end/target, what it follows and why it stops
  refs: MUST be an empty object {} for every shot (no assets exist)
  world_pos: {character label: English absolute position relative to a named landmark, e.g. "at the far end of the corridor, three steps from the half-open door on the left"}
  axis_en: English sentence stating the 180-degree axis (whose line it is) and which side the camera is on
  positions: {character label: {screen_pos, facing, pose, view_target, axis_side}} — screen_pos like "left of the frame"; facing like "toward the camera, turned to his right"; pose = the exact starting pose; view_target = where the eyes are aimed; axis_side like "camera side"
  lighting_en: English sentence of the explicit lighting baseline (direction, quality, colour, shadows)
  beats: >=2 items, each {time, action, camera, sound, handoff}
      time format is exactly "start-end s" with no space before s, e.g. "0-2s", "2-4s"
      the intervals MUST start at 0, be contiguous (no gaps, no overlaps), and the last MUST end exactly at duration
      action = the visible action performed in that beat (English, one or more full sentences)
      sound = the synchronous diegetic sound (English); handoff = the movement state carried to the next segment
  first_frame_hard: English sentence of the opening state of this shot
  last_frame_hard: English sentence of the closing state handed to the next segment
  overall_soundscape: 1-4 English sentences summarising ambient/action/non-verbal sound (no dialogue)
  non_diegetic_music: 1-3 English sentences, or exactly "N/A"
  shot_purpose: one English sentence, self-contained (it becomes the Ref2VA summary)
  cut_reason / continuity_risk: short Chinese notes; fidelity_lock: true

HARD RULES
1. ZERO-PRONOUN: the final prompt must never rely on context. Never use any of: %(banned)s — not in the action text and not inside dialogue either. Rewrite every cross-shot state as a full physical description.
2. NO DUPLICATED ACTION: no two shots may perform the same visible action (the compiler compares the normalised beats[].action text). Each shot must advance the story with a clearly different action. Restating identity, position and lighting in every shot is REQUIRED and is not a duplication.
3. DURATION BUDGET: the beats must truly fill the duration at a realistic action speed. Do not pad a small action to fill seconds; add reaction, breath, gaze or small physical beats so the timing is honest.
4. ONLY the chapter's events (fidelity lock). Do not invent characters, places, or plot events that are not in the chapter. Non-visual backstory may inform appearance/behaviour, never become a new scene.
5. TASTEFUL AND NON-SEXUAL: keep the camera respectful and restrained; never depict nudity, undressing, or sexualised content. The closing moment is quiet suspense only — the camera stays outside the door.
6. COVERAGE: cover the chapter scene by scene and do not silently drop it. Use about %(shots_hint)d shots, total roughly %(target_total)s seconds.
7. Style continuity: art_style_prefix is a single frozen English sentence (format, look, palette) written into every segment; choose it from the chapter's tone.
8. FACING CONSISTENCY: positions[].facing must agree with pose and view_target. A boy looking up at a sign faces the sign, not the lens; two people talking to each other share an eyeline between them. Do NOT default every subject to "toward the camera" and do NOT aim view_target at the camera unless the beat is deliberately a direct-address close-up.
9. CAMERA VARIETY: give at least half of the shots a real camera move (not static) with a clear start, end and reason. Every non-static camera_move_en MUST state where the move STARTS and where it STOPS, using explicit words (e.g. \"starts behind ... and tracks forward ... and stops when he reaches ...\"): a bare \"tracks behind him, following his movement\" is rejected by the gate as non-executable. Never write three consecutive shots with the same shot size, the same angle and a static camera.
10. SPOKEN LINES: reproduce the chapter's spoken lines VERBATIM, in their original language, inside the beat action, using the H3 dialogue syntax with stable speaker IDs, e.g. "The elderly gatekeeper (S1) says: <d>[Chinese] 你好，请稍等一下。</d>". Characters who never speak get no speaker ID. Do not paraphrase dialogue.
11. EYELINE AND STAGING: keep the 180-degree axis stable and state which side the camera is on; the same character keeps the same left/right screen side across shots in one scene unless the camera legitimately moves.
12. COMPACT OUTPUT: keep every phrase tight — one clause per action sentence, 2 beats per shot, no filler adjectives. A long storyboard risks being cut off before it is closed, so earn every word.

CONTRACT JSON SCHEMA (authoritative field list):
%(schema)s

STYLE REFERENCE (a filled storyboard for a different story; mimic its depth and phrasing, but note it HAS reference images — you must use refs:{} everywhere and omit ref_front):
%(example)s
""" % {
        "seg_max": seg_max,
        "banned": BANNED_HINT,
        "shots_hint": shots_hint,
        "target_total": target_total,
        "schema": schema_text,
        "example": example_text,
    }
    return rules


def build_user_prompt(novel_text):
    return (
        "NOVEL CHAPTER (Chinese, verbatim source; adapt it into shots):\n"
        "----8<----\n" + novel_text.strip() + "\n----8<----\n\n"
        "Now output the storyboard.json for this chapter. JSON only."
    )


# ─────────────────────────────────────────────
# 3. 门禁闭环（复用 compile_storyboard.py --json）
# ─────────────────────────────────────────────

def run_gate(storyboard_path, compiler_path):
    """调用编译器门禁，返回 (errors, warns, parsed_ok)。"""
    cmd = [sys.executable, str(compiler_path), "--storyboard-file", str(storyboard_path), "--json"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=120)
    except subprocess.TimeoutExpired:
        return ["门禁超时"], [], False
    out = (proc.stdout or "").strip()
    try:
        payload = json.loads(out)
    except Exception:
        return ["门禁输出无法解析（stderr：%s）" % (proc.stderr or "").strip()[:300]], [], False
    issues = payload.get("issues") or []
    errors = [i["msg"] for i in issues if i.get("level") == "error"]
    warns = [i["msg"] for i in issues if i.get("level") == "warn"]
    return errors, warns, True


def shape_check(sb):
    """结构/必填的轻量校验（不依赖 jsonschema）。"""
    errs = []
    if not isinstance(sb, dict):
        return ["根节点不是对象"]
    for k in ("schema_version", "art_style_prefix", "characters", "scenes", "shots"):
        if k not in sb:
            errs.append("缺少顶层字段：%s" % k)
    if not (sb.get("characters") or {}):
        errs.append("characters 为空")
    if not (sb.get("scenes") or {}):
        errs.append("scenes 为空")
    shots = sb.get("shots") or []
    if not shots:
        errs.append("shots 为空")
    for i, s in enumerate(shots):
        for k in ("id", "scene", "duration", "beats"):
            if k not in s:
                errs.append("shots[%d] 缺少 %s" % (i, k))
    return errs


# ─────────────────────────────────────────────
# 4. main
# ─────────────────────────────────────────────

def build_parser():
    p = argparse.ArgumentParser(
        description="小说正文 → storyboard.json（本地 LLM 起草 + 编译器门禁闭环）。")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--novel-file", help="小说/剧本正文文件（.md/.txt）")
    src.add_argument("--novel-text", help="直接以命令行传入正文（短文本）")
    p.add_argument("--out", required=True, help="写出的 storyboard.json 路径")
    p.add_argument("--base-url", default=DEFAULT_BASE_URL, help="OpenAI 兼容端点（默认 %s）" % DEFAULT_BASE_URL)
    p.add_argument("--model", default=DEFAULT_MODEL, help="模型名（默认 %s）" % DEFAULT_MODEL)
    p.add_argument("--api-key", default=DEFAULT_API_KEY, help="API Key（本地 llama.cpp 可任意）")
    p.add_argument("--shots-hint", type=int, default=8, help="期望镜数（提示，非强制）")
    p.add_argument("--target-total", type=float, default=32.0, help="目标总时长（秒，提示）")
    p.add_argument("--seg-max", type=float, default=5.0, help="单镜时长上限（秒，避免编译器自动拆分）")
    p.add_argument("--art-style", default=None, help="强制 art_style_prefix（不给则让模型按原文定）")
    p.add_argument("--temperature", type=float, default=0.6)
    p.add_argument("--top-p", type=float, default=0.95)
    p.add_argument("--max-tokens", type=int, default=16384)
    p.add_argument("--timeout", type=float, default=900.0, help="单次请求超时（秒）")
    p.add_argument("--attempts", type=int, default=3, help="含门禁回灌的最大重试次数")
    p.add_argument("--think", action="store_true", help="打开模型思考（默认关，直出 JSON）")
    p.add_argument("--json-mode", action="store_true", help="请求 response_format=json_object（语法约束输出）")
    p.add_argument("--no-gate", action="store_true", help="不在生成后跑编译器门禁闭环")
    p.add_argument("--dump-prompt", action="store_true", help="打印最终提示词后退出（不发请求）")
    p.add_argument("--dry-run", action="store_true", help="同 --dump-prompt（语义别名）")
    p.add_argument("--keep-raw", help="保存模型原始输出（每次尝试）到该目录")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.novel_text:
        novel = args.novel_text
    else:
        novel = read_text(args.novel_file)

    schema_text = load_reference("storyboard.schema.json")
    example_text = load_reference("storyboard.example.json")
    system = build_system_prompt(schema_text, example_text, args.shots_hint, args.target_total, args.seg_max)
    if args.art_style:
        system += "\nUse exactly this art_style_prefix: %s\n" % args.art_style
    user = build_user_prompt(novel)

    if args.dump_prompt or args.dry_run:
        safe_print("===== SYSTEM =====\n" + system)
        safe_print("\n===== USER =====\n" + user)
        return 0

    client = LLMClient(
        args.base_url, args.model, args.api_key, args.timeout, args.temperature,
        args.top_p, args.max_tokens, args.think,
        {"type": "json_object"} if args.json_mode else None,
    )
    compiler = HERE / "compile_storyboard.py"
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    out_path = Path(args.out)

    best = None  # (errors, sb)
    for attempt in range(1, args.attempts + 1):
        safe_print("\n== 尝试 %d/%d：请求 %s（model=%s）==" % (attempt, args.attempts, args.base_url, args.model))
        raw = client.chat(messages)
        if args.keep_raw:
            d = Path(args.keep_raw)
            d.mkdir(parents=True, exist_ok=True)
            (d / ("attempt%d.raw.txt" % attempt)).write_text(raw, encoding="utf-8")

        try:
            sb = extract_json(raw)
        except Exception as e:
            truncated = "不闭合" in str(e)
            safe_print("[结构] JSON 解析失败：%s" % e)
            hint = ("Your previous output was CUT OFF before the JSON object was closed. "
                    "Output a SHORTER storyboard this time: keep the same shots but use tighter action "
                    "sentences (one clause each), at most 2 beats per shot, and no extra prose. "
                    "Output ONLY the complete storyboard.json."
                    if truncated else
                    "Your output was not a single valid JSON object (%s). Output ONLY the storyboard.json again, "
                    "with no fences and no prose." % e)
            messages += [{"role": "assistant", "content": raw},
                         {"role": "user", "content": hint}]
            continue

        errs = shape_check(sb)
        if not errs and not args.no_gate:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(sb, ensure_ascii=False, indent=2), encoding="utf-8")
            gate_errors, gate_warns, parsed = run_gate(out_path, compiler)
            if parsed:
                errs = gate_errors
                for w in gate_warns:
                    safe_print("[门禁][warn] %s" % w)
            else:
                errs = gate_errors

        if not errs:
            if best is None or True:
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(json.dumps(sb, ensure_ascii=False, indent=2), encoding="utf-8")
            safe_print("[OK] 门禁通过（第 %d 次尝试）。已写出：%s" % (attempt, out_path))
            return 0

        safe_print("[门禁] error=%d：" % len(errs))
        for e in errs[:40]:
            safe_print("  - %s" % e)
        if best is None or len(errs) < len(best[0]):
            best = (errs, sb)
        messages += [
            {"role": "assistant", "content": json.dumps(sb, ensure_ascii=False)},
            {"role": "user", "content": (
                "The compiler rejected this storyboard with %d error(s):\n%s\n\n"
                "Fix ALL of them and output the COMPLETE corrected storyboard.json again (JSON only). "
                "Keep everything that was already valid; do not drop shots or characters." % (
                    len(errs), "\n".join("- " + e for e in errs)))},
        ]

    # 用尽重试：落盘最优草稿，返回非零
    if best is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(best[1], ensure_ascii=False, indent=2), encoding="utf-8")
        safe_print("\n[FAIL] %d 次尝试后仍有 %d 个 error；已写出最优草稿：%s（请人工修订后重编）"
                   % (args.attempts, len(best[0]), out_path))
    else:
        safe_print("\n[FAIL] %d 次尝试均未产出可解析的 storyboard。" % args.attempts)
    return 1


if __name__ == "__main__":
    sys.exit(main())

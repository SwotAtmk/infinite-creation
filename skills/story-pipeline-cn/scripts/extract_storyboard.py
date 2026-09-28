#!/usr/bin/env python3
# extract_storyboard.py
# ========================================
# 小说/剧本文案 → 分镜脚本 + 角色特征卡 + 场景特征卡
# 输出下游生成工具兼容的 storyboard.json + 人读 storyboard.md
#
# 本脚本是 story-pipeline-cn 技能「模式 C · 小说转分镜」的文件批量实现。
# 仅依赖 Python 标准库；支持多编码读取；自动建立 姓名→CHAR_xxx 映射。
#
# 用法：
#   python extract_storyboard.py input.txt
#   python extract_storyboard.py input.txt -o outputs/作品名 -f both
#   python extract_storyboard.py input.md --format json
# ========================================

import sys
import os
import json
import re
import argparse
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Tuple


# ─────────────────────────────────────────────
# 0. 工具函数
# ─────────────────────────────────────────────

def read_file(path: str) -> str:
    """读取文本文件，自动检测编码。"""
    encodings = ["utf-8", "utf-8-sig", "gbk", "gb2312", "big5"]
    for enc in encodings:
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, LookupError):
            continue
    raise ValueError("无法解码文件：%s（请转为 utf-8 或 gbk）" % path)


def _safe_print(msg: str) -> None:
    """安全打印：规避 Windows 终端 GBK/CP936 不支持某些字符的问题。"""
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("ascii", errors="replace").decode("ascii"))


def clean_text(text: str) -> str:
    """清理多余空行与空白。"""
    text = re.sub(r"\r\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ─────────────────────────────────────────────
# 1. 段落切分 & 场景识别
# ─────────────────────────────────────────────

SCENE_HEADERS = re.compile(
    r"^[\s]*"
    r"("
    r"(?:INT\.|EXT\.|内景|外景|内:|外:|场景:|场景\s*\d+|第\s*\d+\s*[场幕节]|"
    r"镜头\s*\d+|shot\s*\d+|scene\s*\d+|【场景)"
    r".*"
    r")$",
    re.IGNORECASE | re.MULTILINE
)

DIALOGUE_PATTERN = re.compile(
    r"^[\s]*"
    r"(?P<character>[A-Z\u4e00-\u9fa5·\s]{1,20}?)"
    r"(?:\s*[（(][^）)]{0,30}[）)])?"
    r"\s*[：:]\s*"
    r"(?P<line>.+)$",
    re.MULTILINE
)

ACTION_PATTERN = re.compile(r"^[\s]*[（\(](.+?)[）\)][\s]*$", re.MULTILINE)

CHAPTER_PATTERN = re.compile(
    r"^[\s]*(?:第[一二三四五六七八九十百千\d]+[章节回幕场]|Chapter\s*\d+|CHAPTER\s*\d+)\s*[：:·—\-\s]*(.*)$",
    re.MULTILINE
)


def split_into_paragraphs(text: str) -> List[Dict]:
    """将全文切分为段落列表，并标记段落类型。

    切分规则（兼容「无空行」的粘贴/小说体）：
    - 空行 → 段落断点
    - 场景标头 / 章节行 → 单独成段，并触发新段落
    - 对白行 / 动作行 → 单独成段（与叙事分离，利于角色提取与分镜）
    - 其余连续叙事行 → 合并为一个叙事段落
    """
    paragraphs: List[str] = []
    buf: List[str] = []

    def flush() -> None:
        t = "\n".join(buf).strip()
        if t:
            paragraphs.append(t)
        buf.clear()

    for line in text.split("\n"):
        line = line.strip()
        if not line:
            flush()
            continue
        if SCENE_HEADERS.match(line) or CHAPTER_PATTERN.match(line):
            flush()
            paragraphs.append(line)
            continue
        if DIALOGUE_PATTERN.match(line) or ACTION_PATTERN.match(line):
            flush()
            paragraphs.append(line)
            continue
        buf.append(line)
    flush()

    out: List[Dict] = []
    for t in paragraphs:
        if SCENE_HEADERS.match(t):
            p_type = "scene_header"
        elif CHAPTER_PATTERN.match(t):
            p_type = "chapter"
        elif DIALOGUE_PATTERN.search(t):
            p_type = "dialogue"
        elif ACTION_PATTERN.search(t):
            p_type = "action"
        else:
            p_type = "narrative"
        out.append({"text": t, "type": p_type})
    return out


# ─────────────────────────────────────────────
# 2. 角色提取（含 CHAR_xxx 映射）
# ─────────────────────────────────────────────

def extract_characters(text: str, paragraphs: List[Dict]) -> Tuple[Dict, Dict]:
    """提取角色及其特征，并建立 姓名→CHAR_xxx 映射。"""
    characters: Dict[str, Dict] = {}

    for m in DIALOGUE_PATTERN.finditer(text):
        name = m.group("character").strip()
        if len(name) < 1 or name in ("旁白", "OS", "VO", "系统音", "画外音"):
            continue
        if name not in characters:
            characters[name] = {
                "name": name,
                "appearances": 0,
                "dialogues": 0,
                "appearance_desc": [],
                "personality_desc": [],
                "sample_lines": [],
            }
        characters[name]["dialogues"] += 1
        line = m.group("line").strip()
        if len(characters[name]["sample_lines"]) < 3:
            characters[name]["sample_lines"].append(line)

    desc_patterns = [
        (re.compile(r"([^\s，。？！]{1,10})\s*(?:是一个|是位|是名|是个)\s*(.{2,40}?)(?=[，。\n])"), "appearance_desc"),
        (re.compile(r"([^\s，。？！]{1,10})\s*(?:的性格|为人|生性|向来|一向)\s*(.{2,40}?)(?=[，。\n])"), "personality_desc"),
        (re.compile(r"([^\s，。？！]{1,10})\s*(?:的脸|的眼睛|的头发|的身材|长相|外貌|面容)\s*(.{2,40}?)(?=[，。\n])"), "appearance_desc"),
    ]

    narrative_text = " ".join(p["text"] for p in paragraphs if p["type"] == "narrative")
    for pattern, field in desc_patterns:
        for m in pattern.finditer(narrative_text):
            name = m.group(1).strip()
            desc = m.group(2).strip()
            if name in characters and desc not in characters[name][field]:
                characters[name][field].append(desc)

    for name in characters:
        characters[name]["appearances"] = len(re.findall(re.escape(name), text))

    # 按出场次数降序分配 CHAR_xxx
    ordered = sorted(characters.keys(), key=lambda n: characters[n]["appearances"], reverse=True)
    char_index: Dict[str, str] = {}
    for i, name in enumerate(ordered, start=1):
        char_index[name] = "CHAR_%03d" % i

    return characters, char_index


# ─────────────────────────────────────────────
# 3. 场景提取
# ─────────────────────────────────────────────

LOCATION_KEYWORDS = {
    "室内": ["房间", "客厅", "卧室", "书房", "办公室", "会议室", "餐厅", "厨房",
             "走廊", "电梯", "地下室", "酒吧", "咖啡厅", "商场", "学校", "医院"],
    "室外": ["街道", "广场", "公园", "山顶", "海边", "森林", "田野", "操场",
             "停车场", "天台", "桥上", "码头", "机场", "车站"],
    "特殊": ["梦境", "幻觉", "回忆", "过去", "未来", "异世界", "宇宙"],
}

TIME_KEYWORDS = {
    "白天": ["白天", "上午", "下午", "午后", "清晨", "正午", "日出"],
    "夜晚": ["夜晚", "深夜", "夜里", "夜间", "凌晨", "黎明前", "子夜", "黑夜"],
    "黄昏": ["黄昏", "傍晚", "日暮", "暮色", "晚霞"],
}

MOOD_KEYWORDS = {
    "紧张": ["紧张", "心跳", "颤抖", "冷汗", "警觉", "逃跑", "追赶", "危险", "恐惧"],
    "温馨": ["温暖", "微笑", "笑声", "拥抱", "温柔", "甜蜜", "幸福"],
    "压抑": ["沉默", "压抑", "窒息", "黑暗", "绝望", "死亡", "悲哀", "泪水"],
    "激烈": ["战斗", "爆炸", "冲突", "对峙", "争吵", "厮打", "爆发"],
    "神秘": ["神秘", "诡异", "阴影", "未知", "秘密", "隐藏", "低语"],
}


def _detect(keywords: Dict[str, List[str]], text: str, default: str) -> str:
    for k_type, kws in keywords.items():
        for kw in kws:
            if kw in text:
                return k_type
    return default


def extract_scenes(paragraphs: List[Dict]) -> List[Dict]:
    scenes = []
    current: Optional[Dict] = None

    for p in paragraphs:
        if p["type"] in ("scene_header", "chapter") or current is None:
            if current is not None:
                scenes.append(current)
            current = {
                "id": len(scenes) + 1,
                "header": p["text"] if p["type"] in ("scene_header", "chapter") else "（开场）",
                "paragraphs": [],
                "characters_in_scene": set(),
            }
            if p["type"] not in ("scene_header", "chapter"):
                current["paragraphs"].append(p)
        else:
            current["paragraphs"].append(p)
            for m in DIALOGUE_PATTERN.finditer(p["text"]):
                current["characters_in_scene"].add(m.group("character").strip())

    if current:
        scenes.append(current)

    for scene in scenes:
        full_text = "\n".join(p["text"] for p in scene["paragraphs"])
        scene["location_type"] = _detect(LOCATION_KEYWORDS, full_text, "未定")
        scene["time_of_day"] = _detect(TIME_KEYWORDS, full_text, "未知")
        scene["mood"] = _detect(MOOD_KEYWORDS, full_text, "平静")
        scene["characters_in_scene"] = sorted(scene["characters_in_scene"])
        narrative_parts = [p["text"] for p in scene["paragraphs"] if p["type"] == "narrative"]
        scene["location_desc"] = (narrative_parts[0][:120].rstrip("，。") + "……") if narrative_parts else ""

    return scenes


# ─────────────────────────────────────────────
# 4. 分镜脚本生成
# ─────────────────────────────────────────────

SHOT_TYPE_MAP = {
    "远景": "ELS", "全景": "LS", "中景": "MS", "近景": "MCU",
    "特写": "CU", "大特写": "ECU", "俯拍": "CRANE", "仰拍": "TILT", "跟拍": "TRACKING",
}


def infer_shot_type(text: str, prev_type: str = "") -> str:
    if any(k in text for k in ["远处", "全景", "俯瞰", "环境", "风景", "一片", "整个"]):
        return "远景"
    if any(k in text for k in ["走进", "走来", "出现", "站在", "坐在", "靠在"]):
        return "全景"
    if any(k in text for k in ["说", "道", "问", "答", "喊", "低声", "笑道", "叹道"]):
        return "近景"
    if any(k in text for k in ["眼睛", "眼神", "表情", "嘴角", "手指", "细节", "微微"]):
        return "特写"
    if any(k in text for k in ["心中", "脑海", "想到", "意识到", "感受到"]):
        return "大特写"
    defaults = ["中景", "全景", "中景", "近景"]
    idx = list(SHOT_TYPE_MAP).index(prev_type) if prev_type in SHOT_TYPE_MAP else 2
    return defaults[idx % len(defaults)]


def _infer_light(time: str, mood: str) -> str:
    if mood in ("压抑", "神秘"):
        return "低光·冷调"
    if time == "夜晚":
        return "月光·街灯·点光源"
    if time == "黄昏":
        return "暖橙逆光"
    if time == "白天":
        return "自然光·散射"
    return "中性光"


def _infer_color_tone(mood: str) -> str:
    return {
        "紧张": "高对比冷蓝绿", "温馨": "暖黄橙低饱和", "压抑": "去饱和冷灰",
        "激烈": "高饱和红橙", "神秘": "深蓝紫暗调", "平静": "中性自然色",
    }.get(mood, "中性自然色")


def _infer_sound(mood: str) -> str:
    return {
        "紧张": "低频警报·急促心跳声", "温馨": "轻柔钢琴·背景人声", "压抑": "沉默·低沉弦乐",
        "激烈": "打击乐·音效爆破", "神秘": "环境音·诡异回响", "平静": "自然环境音",
    }.get(mood, "自然环境音")


def _infer_camera_move(p_type: str, shot_type: str) -> str:
    if p_type == "action":
        return "TRACKING"
    if shot_type in ("远景", "全景"):
        return "SLOW PUSH"
    if shot_type in ("特写", "大特写"):
        return "STATIC·SLOW ZOOM"
    return "STATIC"


def _estimate_duration(shot_type: str, mood: str) -> int:
    if shot_type in ("特写", "大特写") or mood in ("紧张", "激烈"):
        return 2
    if mood in ("神秘", "压抑"):
        return 3
    if shot_type in ("远景", "全景"):
        return 5
    return 4


def generate_storyboard(scenes: List[Dict], characters: Dict, char_index: Dict) -> List[Dict]:
    storyboard = []
    shot_counter = 0
    prev_shot_type = ""

    for scene in scenes:
        scene_no = "S%02d" % scene["id"]
        # 建立镜头
        shot_counter += 1
        establish = {
            "shot_id": "%s_%02d" % (scene_no, shot_counter),
            "scene_id": scene_no,
            "duration": 5,
            "shot_type": "LS" if scene["location_type"] in ("室外", "特殊") else "MS",
            "shot_type_cn": "全景" if scene["location_type"] in ("室外", "特殊") else "中景",
            "description_cn": "【建立镜头】" + (scene["location_desc"] or scene["header"]),
            "image_prompt": scene["location_desc"] or scene["header"],
            "video_prompt": "slow push in" if scene["mood"] in ("紧张", "激烈") else "static shot",
            "characters": [char_index.get(c, c) for c in scene["characters_in_scene"]],
            "dialogue": "",
            "mood": scene["mood"],
            "color_tone": _infer_color_tone(scene["mood"]),
            "light": _infer_light(scene["time_of_day"], scene["mood"]),
            "sound": _infer_sound(scene["mood"]),
            "camera_move": "SLOW PUSH" if scene["mood"] in ("紧张", "激烈") else "STATIC",
            "reference_image": None,
        }
        storyboard.append(establish)
        prev_shot_type = establish["shot_type_cn"]

        for p in scene["paragraphs"]:
            shot_counter += 1
            shot_type_cn = infer_shot_type(p["text"], prev_shot_type)
            prev_shot_type = shot_type_cn

            dialogue_lines = ["%s：%s" % (m.group("character"), m.group("line"))
                              for m in DIALOGUE_PATTERN.finditer(p["text"])]
            action_notes = ACTION_PATTERN.findall(p["text"])

            content = DIALOGUE_PATTERN.sub("", p["text"]).strip()
            content = ACTION_PATTERN.sub("", content).strip()
            if len(content) > 100:
                content = content[:100] + "……"

            chars = list({m.group("character").strip() for m in DIALOGUE_PATTERN.finditer(p["text"])})

            storyboard.append({
                "shot_id": "%s_%02d" % (scene_no, shot_counter),
                "scene_id": scene_no,
                "duration": _estimate_duration(shot_type_cn, scene["mood"]),
                "shot_type": SHOT_TYPE_MAP.get(shot_type_cn, "MS"),
                "shot_type_cn": shot_type_cn,
                "description_cn": content or p["text"][:80],
                "image_prompt": content or p["text"][:80],
                "video_prompt": _infer_camera_move(p["type"], shot_type_cn),
                "characters": [char_index.get(c, c) for c in chars],
                "dialogue": " / ".join(dialogue_lines),
                "mood": scene["mood"],
                "color_tone": _infer_color_tone(scene["mood"]),
                "light": _infer_light(scene["time_of_day"], scene["mood"]),
                "sound": _infer_sound(scene["mood"]),
                "camera_move": _infer_camera_move(p["type"], shot_type_cn),
                "reference_image": None,
            })

    return storyboard


# ─────────────────────────────────────────────
# 5. 角色 / 场景特征卡
# ─────────────────────────────────────────────

def build_character_cards(characters: Dict, char_index: Dict, storyboard: List[Dict]) -> List[Dict]:
    cards = []
    for name, data in characters.items():
        cid = char_index[name]
        shot_nos = [s["shot_id"] for s in storyboard if cid in s["characters"]]
        prompt_kw = [name] + data.get("appearance_desc", [])[:2] + data.get("personality_desc", [])[:1]
        cards.append({
            "char_id": cid,
            "name": name,
            "total_appearances": data["appearances"],
            "dialogue_count": data["dialogues"],
            "shot_count": len(shot_nos),
            "shot_nos": shot_nos[:10],
            "appearance_traits": data.get("appearance_desc", []),
            "personality_traits": data.get("personality_desc", []),
            "sample_dialogues": data.get("sample_lines", [])[:3],
            "ai_prompt_hint_cn": "，".join(prompt_kw[:5]) + "，电影级写实风格",
            "ai_prompt_hint_en": "",
        })
    cards.sort(key=lambda x: x["total_appearances"], reverse=True)
    return cards


def build_scene_cards(scenes: List[Dict], char_index: Dict) -> List[Dict]:
    cards = []
    mood_prompts = {
        "紧张": "dramatic tension, high contrast, shallow depth of field",
        "温馨": "warm soft light, golden hour, cozy atmosphere",
        "压抑": "desaturated, dark shadows, oppressive space",
        "激烈": "action shot, motion blur, vibrant colors",
        "神秘": "fog, silhouette, mysterious ambiance, blue tint",
        "平静": "natural light, balanced composition, serene",
    }
    for scene in scenes:
        mood = scene["mood"]
        ai_prompt = "%s，%s，%s，%s，%s，8K电影分镜概念图" % (
            (scene["location_desc"][:50] if scene["location_desc"] else scene["header"]),
            scene["location_type"], scene["time_of_day"], _infer_color_tone(mood),
            mood_prompts.get(mood, "cinematic"))
        cards.append({
            "scene_id": "S%02d" % scene["id"],
            "header": scene["header"],
            "location_type": scene["location_type"],
            "time_of_day": scene["time_of_day"],
            "mood": mood,
            "color_tone": _infer_color_tone(mood),
            "light": _infer_light(scene["time_of_day"], mood),
            "sound": _infer_sound(mood),
            "characters_present": [char_index.get(c, c) for c in scene["characters_in_scene"]],
            "location_desc": scene.get("location_desc", ""),
            "ai_scene_prompt": ai_prompt,
        })
    return cards


# ─────────────────────────────────────────────
# 6. 输出格式化
# ─────────────────────────────────────────────

def format_markdown(storyboard, character_cards, scene_cards, source_file) -> str:
    lines = []
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines.append("# 分镜脚本报告")
    lines.append("\n> 源文件：`%s`  |  生成时间：%s\n" % (source_file, ts))
    lines.append("## 统计摘要\n")
    lines.append("| 指标 | 数量 |\n|------|------|")
    lines.append("| 总镜头数 | **%d** |" % len(storyboard))
    lines.append("| 场景数 | **%d** |" % len(scene_cards))
    lines.append("| 角色数 | **%d** |\n" % len(character_cards))

    lines.append("## 分镜脚本\n")
    current_scene_id = None
    for shot in storyboard:
        if shot["scene_id"] != current_scene_id:
            current_scene_id = shot["scene_id"]
            sc = next((s for s in scene_cards if s["scene_id"] == current_scene_id), None)
            if sc:
                lines.append("\n### 场景 %s：%s" % (current_scene_id, sc["header"]))
                lines.append("**地点类型**：%s  **时间**：%s  **氛围**：%s\n" % (
                    sc["location_type"], sc["time_of_day"], sc["mood"]))
        chars = "、".join(shot["characters"]) if shot["characters"] else "无特定角色"
        lines.append("#### 镜头 %s  `%s`" % (shot["shot_id"], shot["shot_type"]))
        lines.append("\n| 项目 | 内容 |\n|------|------|")
        lines.append("| 画面内容 | %s |" % shot["description_cn"])
        lines.append("| 出场角色 | %s |" % chars)
        lines.append("| 摄影机运动 | %s |" % shot["camera_move"])
        lines.append("| 光线 | %s |" % shot["light"])
        lines.append("| 色调 | %s |" % shot["color_tone"])
        lines.append("| 音效/配乐 | %s |" % shot["sound"])
        if shot["dialogue"]:
            lines.append("| 对白 | %s |" % shot["dialogue"])
        lines.append("")

    lines.append("---\n## 角色特征卡\n")
    for card in character_cards:
        lines.append("### %s — %s" % (card["char_id"], card["name"]))
        lines.append("\n| 属性 | 内容 |\n|------|------|")
        lines.append("| 总出场次数 | %d |" % card["total_appearances"])
        lines.append("| 对白条数 | %d |" % card["dialogue_count"])
        lines.append("| 出镜镜头数 | %d |" % card["shot_count"])
        if card["appearance_traits"]:
            lines.append("| 外貌特征 | %s |" % "；".join(card["appearance_traits"]))
        if card["personality_traits"]:
            lines.append("| 性格特征 | %s |" % "；".join(card["personality_traits"]))
        if card["sample_dialogues"]:
            lines.append("| 代表台词 | %s |" % "；".join("「%s」" % d for d in card["sample_dialogues"]))
        lines.append("| AI 绘图提示词(中) | `%s` |" % card["ai_prompt_hint_cn"])
        lines.append("")

    lines.append("---\n## 场景特征卡\n")
    for card in scene_cards:
        chars = "、".join(card["characters_present"]) if card["characters_present"] else "无"
        lines.append("### 场景 %s：%s" % (card["scene_id"], card["header"]))
        lines.append("\n| 属性 | 内容 |\n|------|------|")
        lines.append("| 地点类型 | %s |" % card["location_type"])
        lines.append("| 时间 | %s |" % card["time_of_day"])
        lines.append("| 氛围 | %s |" % card["mood"])
        lines.append("| 色调 | %s |" % card["color_tone"])
        lines.append("| 光线 | %s |" % card["light"])
        lines.append("| 音效 | %s |" % card["sound"])
        lines.append("| 出场人物 | %s |" % chars)
        if card["location_desc"]:
            lines.append("| 场景描述 | %s |" % card["location_desc"])
        lines.append("| AI 场景提示词 | `%s` |" % card["ai_scene_prompt"])
        lines.append("")

    lines.append("\n---\n> ⚠ 提示：`image_prompt`/`video_prompt` 当前为中文草稿，出图出视频前须译为英文。\n")
    return "\n".join(lines)


def format_json(storyboard, character_cards, scene_cards, char_index, source_file) -> str:
    data = {
        "title": Path(source_file).stem,
        "art_style_prefix": "",
        "character_index": char_index,
        "prompt_language": "zh-draft",
        "prompt_note": "image_prompt/video_prompt 当前为中文草稿，出图前须译为英文；art_style_prefix 须填写画风标签。",
        "summary": {
            "total_shots": len(storyboard),
            "total_scenes": len(scene_cards),
            "total_characters": len(character_cards),
        },
        "storyboard": storyboard,
        "character_cards": character_cards,
        "scene_cards": scene_cards,
        "generated_at": datetime.now().isoformat(),
    }
    return json.dumps(data, ensure_ascii=False, indent=2)


# ─────────────────────────────────────────────
# 7. 主入口
# ─────────────────────────────────────────────

def process(input_path: str, output_dir: str = ".", fmt: str = "markdown") -> str:
    raw = read_file(input_path)
    text = clean_text(raw)
    source_name = Path(input_path).stem

    paragraphs = split_into_paragraphs(text)
    scenes = extract_scenes(paragraphs)
    characters, char_index = extract_characters(text, paragraphs)
    storyboard = generate_storyboard(scenes, characters, char_index)
    character_cards = build_character_cards(characters, char_index, storyboard)
    scene_cards = build_scene_cards(scenes, char_index)

    os.makedirs(output_dir, exist_ok=True)
    output_files = []

    if fmt in ("markdown", "both"):
        md = format_markdown(storyboard, character_cards, scene_cards, source_name)
        md_path = os.path.join(output_dir, "%s_storyboard.md" % source_name)
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(md)
        output_files.append(md_path)
        _safe_print("[OK] Markdown 已生成: %s" % md_path)

    if fmt in ("json", "both"):
        js = format_json(storyboard, character_cards, scene_cards, char_index, source_name)
        js_path = os.path.join(output_dir, "%s_storyboard.json" % source_name)
        with open(js_path, "w", encoding="utf-8") as f:
            f.write(js)
        output_files.append(js_path)
        _safe_print("[OK] JSON 已生成: %s" % js_path)

    _safe_print("\n[处理完成]")
    _safe_print("   总镜头数: %d" % len(storyboard))
    _safe_print("   场景数: %d" % len(scene_cards))
    _safe_print("   角色数: %d" % len(character_cards))
    for card in character_cards[:5]:
        _safe_print("   角色 [%s]%s 出场 %d 次, %d 条对白" % (
            card["char_id"], card["name"], card["total_appearances"], card["dialogue_count"]))

    return output_files[0] if output_files else ""


def main():
    parser = argparse.ArgumentParser(
        description="小说/剧本文案 → 分镜脚本 + 角色卡 + 场景卡（下游生成工具兼容 JSON）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  python extract_storyboard.py input.txt
  python extract_storyboard.py input.txt -o outputs/作品名 -f both
  python extract_storyboard.py input.md --format json
"""
    )
    parser.add_argument("input", help="输入文件路径（.txt 或 .md）")
    parser.add_argument("-o", "--output", default=".", help="输出目录，默认当前目录")
    parser.add_argument("-f", "--format", choices=["markdown", "json", "both"],
                        default="markdown", help="输出格式：markdown | json | both")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print("[ERROR] 文件不存在：%s" % args.input, file=sys.stderr)
        sys.exit(1)

    process(args.input, args.output, args.format)


if __name__ == "__main__":
    main()

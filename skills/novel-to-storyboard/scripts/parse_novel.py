# novel-to-storyboard / parse_novel.py
# ========================================
# 小说/剧本文案 → 分镜脚本 + 角色特征 + 场景特征
# Version: 1.0.0
# Author: WorkBuddy Skill

import sys
import os
import json
import re
import argparse
from pathlib import Path
from datetime import datetime

# ─────────────────────────────────────────────
# 0. 工具函数
# ─────────────────────────────────────────────

def read_file(path: str) -> str:
    """读取文本文件，自动检测编码"""
    encodings = ["utf-8", "utf-8-sig", "gbk", "gb2312", "big5"]
    for enc in encodings:
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, LookupError):
            continue
    raise ValueError(f"无法解码文件：{path}")


def _safe_print(msg: str):
    """安全打印：规避 Windows 终端 GBK/CP936 编码不支持 emoji 的问题"""
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("ascii", errors="replace").decode("ascii"))


def clean_text(text: str) -> str:
    """清理多余空行和空白"""
    text = re.sub(r"\r\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ─────────────────────────────────────────────
# 1. 段落切分 & 场景识别
# ─────────────────────────────────────────────

# 场景切换关键词（中文剧本常见写法）
SCENE_HEADERS = re.compile(
    r"^[\s]*"
    r"("
    r"(?:INT\.|EXT\.|内景|外景|内:|外:|场景:|场景\s*\d+|第\s*\d+\s*[场幕节]|"
    r"镜头\s*\d+|shot\s*\d+|scene\s*\d+)"
    r".*"
    r")$",
    re.IGNORECASE | re.MULTILINE
)

# 对白行识别：支持以下格式
#   角色：台词
#   角色（动作/情绪）：台词
#   角色 (action)：台词
DIALOGUE_PATTERN = re.compile(
    r"^[\s]*"
    r"(?P<character>[A-Z\u4e00-\u9fa5·\s【】]{1,20}?)"
    r"(?:\s*[（(][^）)]{0,30}[）)])?"
    r"\s*[：:]\s*"
    r"(?P<line>.+)$",
    re.MULTILINE
)

# 动作/描述行（括号内）
ACTION_PATTERN = re.compile(r"^[\s]*[（\(](.+?)[）\)][\s]*$", re.MULTILINE)

# 段落/章节标题
CHAPTER_PATTERN = re.compile(
    r"^[\s]*(?:第[一二三四五六七八九十百千\d]+[章节回幕场]|Chapter\s*\d+|CHAPTER\s*\d+)\s*[：:·—\-\s]*(.*)$",
    re.MULTILINE
)


def split_into_paragraphs(text: str) -> list[dict]:
    """将全文切分为段落列表，并标记段落类型"""
    paragraphs = []
    for raw in text.split("\n\n"):
        stripped = raw.strip()
        if not stripped:
            continue

        p_type = "narrative"  # 默认叙事
        if SCENE_HEADERS.match(stripped):
            p_type = "scene_header"
        elif CHAPTER_PATTERN.match(stripped):
            p_type = "chapter"
        elif DIALOGUE_PATTERN.search(stripped):
            p_type = "dialogue"
        elif ACTION_PATTERN.search(stripped):
            p_type = "action"

        paragraphs.append({"text": stripped, "type": p_type})

    return paragraphs


# ─────────────────────────────────────────────
# 2. 角色提取
# ─────────────────────────────────────────────

def extract_characters(text: str, paragraphs: list[dict]) -> dict[str, dict]:
    """
    提取角色及其特征。
    策略：
    1. 从对白行提取出场角色名
    2. 从叙事段落中寻找"XXX是一个/是位/外表/身材/性格"等描述
    3. 统计每个角色的出场次数
    """
    characters: dict[str, dict] = {}

    # 从对白提取出场角色
    for m in DIALOGUE_PATTERN.finditer(text):
        name = m.group("character").strip()
        # 过滤极短或明显噪音
        if len(name) < 1 or name in ("旁白", "OS", "VO"):
            continue
        if name not in characters:
            characters[name] = {
                "name": name,
                "appearances": 0,
                "dialogues": 0,
                "traits": [],
                "appearance_desc": [],  # 外貌描述
                "personality_desc": [],  # 性格描述
                "sample_lines": [],
            }
        characters[name]["dialogues"] += 1
        line = m.group("line").strip()
        if len(characters[name]["sample_lines"]) < 3:
            characters[name]["sample_lines"].append(line)

    # 从叙事段落提取角色描述
    desc_patterns = [
        # 外貌
        (re.compile(r"([^\s，。？！]{1,10})\s*(?:是一个|是位|是名|是个)\s*(.{2,40}?)(?=[，。\n])"),
         "appearance_desc"),
        # 性格
        (re.compile(r"([^\s，。？！]{1,10})\s*(?:的性格|为人|生性|向来|一向)\s*(.{2,40}?)(?=[，。\n])"),
         "personality_desc"),
        # 外表描述
        (re.compile(r"([^\s，。？！]{1,10})\s*(?:的脸|的眼睛|的头发|的身材|长相|外貌|面容)\s*(.{2,40}?)(?=[，。\n])"),
         "appearance_desc"),
    ]

    narrative_text = " ".join(p["text"] for p in paragraphs if p["type"] == "narrative")
    for pattern, field in desc_patterns:
        for m in pattern.finditer(narrative_text):
            name = m.group(1).strip()
            desc = m.group(2).strip()
            if name in characters and desc not in characters[name][field]:
                characters[name][field].append(desc)

    # 统计叙事段落中角色出现次数
    for name in characters:
        characters[name]["appearances"] = len(re.findall(re.escape(name), text))

    # 生成综合特征描述
    for name, data in characters.items():
        traits = []
        traits.extend(data["appearance_desc"][:2])
        traits.extend(data["personality_desc"][:2])
        data["traits"] = traits

    return characters


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
    "白天": ["白天", "上午", "下午", "午后", "清晨", "上午", "正午", "日出", "日落前"],
    "夜晚": ["夜晚", "深夜", "夜里", "夜间", "凌晨", "黎明前", "子夜", "黑夜"],
    "黄昏": ["黄昏", "傍晚", "日暮", "暮色", "晚霞"],
    "模糊": [],
}

MOOD_KEYWORDS = {
    "紧张": ["紧张", "心跳", "颤抖", "冷汗", "警觉", "逃跑", "追赶", "危险", "恐惧"],
    "温馨": ["温暖", "微笑", "笑声", "拥抱", "温柔", "甜蜜", "幸福"],
    "压抑": ["沉默", "压抑", "窒息", "黑暗", "绝望", "死亡", "悲哀", "泪水"],
    "激烈": ["战斗", "爆炸", "冲突", "对峙", "争吵", "厮打", "爆发"],
    "神秘": ["神秘", "诡异", "阴影", "未知", "秘密", "隐藏", "低语"],
}


def detect_location(text: str) -> str:
    """推断场景地点类型"""
    for loc_type, kws in LOCATION_KEYWORDS.items():
        for kw in kws:
            if kw in text:
                return loc_type
    return "未定"


def detect_time(text: str) -> str:
    for t_type, kws in TIME_KEYWORDS.items():
        if not kws:
            continue
        for kw in kws:
            if kw in text:
                return t_type
    return "未知"


def detect_mood(text: str) -> str:
    for mood, kws in MOOD_KEYWORDS.items():
        for kw in kws:
            if kw in text:
                return mood
    return "平静"


def extract_scenes(paragraphs: list[dict]) -> list[dict]:
    """将段落聚合为场景列表"""
    scenes = []
    current_scene: dict | None = None

    for p in paragraphs:
        if p["type"] in ("scene_header", "chapter") or current_scene is None:
            if current_scene is not None:
                scenes.append(current_scene)
            current_scene = {
                "id": len(scenes) + 1,
                "header": p["text"] if p["type"] in ("scene_header", "chapter") else "（开场）",
                "paragraphs": [],
                "characters_in_scene": set(),
                "location_type": "未定",
                "time_of_day": "未知",
                "mood": "平静",
                "location_desc": "",
            }
            if p["type"] not in ("scene_header", "chapter"):
                current_scene["paragraphs"].append(p)
        else:
            current_scene["paragraphs"].append(p)
            # 从对白行收集出场角色
            for m in DIALOGUE_PATTERN.finditer(p["text"]):
                current_scene["characters_in_scene"].add(m.group("character").strip())

    if current_scene:
        scenes.append(current_scene)

    # 分析每个场景特征
    for scene in scenes:
        full_text = "\n".join(p["text"] for p in scene["paragraphs"])
        scene["location_type"] = detect_location(full_text)
        scene["time_of_day"] = detect_time(full_text)
        scene["mood"] = detect_mood(full_text)
        scene["characters_in_scene"] = sorted(scene["characters_in_scene"])

        # 提取前100字作为场景描述
        narrative_parts = [p["text"] for p in scene["paragraphs"] if p["type"] == "narrative"]
        if narrative_parts:
            scene["location_desc"] = narrative_parts[0][:120].rstrip("，。") + "……"

    return scenes


# ─────────────────────────────────────────────
# 4. 分镜脚本生成
# ─────────────────────────────────────────────

SHOT_TYPES = ["远景", "全景", "中景", "近景", "特写", "大特写", "俯拍", "仰拍", "跟拍"]

def infer_shot_type(text: str, prev_type: str = "") -> str:
    """
    根据内容语义推断合适的镜头类型。
    规则：
    - 场景开始/环境描述 → 远景/全景
    - 人物出场/动作 → 中景
    - 对白/情绪 → 近景/特写
    - 心理活动/细节 → 特写/大特写
    """
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
    # 默认中景，防止单调则交替
    defaults = ["中景", "全景", "中景", "近景"]
    idx = SHOT_TYPES.index(prev_type) if prev_type in SHOT_TYPES else 2
    return defaults[idx % len(defaults)]


def generate_storyboard(scenes: list[dict], characters: dict) -> list[dict]:
    """
    将场景列表转换为详细分镜脚本。
    每个段落 → 1~3 个分镜。
    """
    storyboard = []
    shot_counter = 0
    prev_shot_type = ""

    for scene in scenes:
        scene_shots = []

        # 场景首帧（环境建立镜头）
        shot_counter += 1
        establish_shot = {
            "shot_no": shot_counter,
            "scene_id": scene["id"],
            "scene_header": scene["header"],
            "shot_type": "全景" if scene["location_type"] in ("室外", "特殊") else "中景",
            "content": f"【建立镜头】{scene['location_desc'] or scene['header']}",
            "characters": scene["characters_in_scene"],
            "location": scene["location_type"],
            "time": scene["time_of_day"],
            "mood": scene["mood"],
            "camera_move": "推镜头" if scene["mood"] in ("紧张", "激烈") else "静止",
            "light": _infer_light(scene["time_of_day"], scene["mood"]),
            "color_tone": _infer_color_tone(scene["mood"]),
            "sound": _infer_sound(scene["mood"]),
            "dialogue": "",
            "action_note": "",
        }
        scene_shots.append(establish_shot)
        prev_shot_type = establish_shot["shot_type"]

        # 段落转镜头
        for p in scene["paragraphs"]:
            shot_counter += 1
            shot_type = infer_shot_type(p["text"], prev_shot_type)
            prev_shot_type = shot_type

            # 提取对白
            dialogue_lines = []
            for m in DIALOGUE_PATTERN.finditer(p["text"]):
                dialogue_lines.append(f"{m.group('character')}：{m.group('line')}")

            # 提取动作提示
            action_notes = ACTION_PATTERN.findall(p["text"])

            # 主内容（去除对白和动作行后的叙事文字）
            content = p["text"]
            content = DIALOGUE_PATTERN.sub("", content).strip()
            content = ACTION_PATTERN.sub("", content).strip()
            if len(content) > 100:
                content = content[:100] + "……"

            shot = {
                "shot_no": shot_counter,
                "scene_id": scene["id"],
                "scene_header": scene["header"],
                "shot_type": shot_type,
                "content": content or p["text"][:80],
                "characters": list({
                    m.group("character").strip()
                    for m in DIALOGUE_PATTERN.finditer(p["text"])
                }),
                "location": scene["location_type"],
                "time": scene["time_of_day"],
                "mood": scene["mood"],
                "camera_move": _infer_camera_move(p["type"], shot_type),
                "light": _infer_light(scene["time_of_day"], scene["mood"]),
                "color_tone": _infer_color_tone(scene["mood"]),
                "sound": _infer_sound(scene["mood"]),
                "dialogue": " / ".join(dialogue_lines),
                "action_note": " / ".join(action_notes),
            }
            scene_shots.append(shot)

        storyboard.extend(scene_shots)

    return storyboard


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
    mapping = {
        "紧张": "高对比冷蓝绿",
        "温馨": "暖黄橙低饱和",
        "压抑": "去饱和冷灰",
        "激烈": "高饱和红橙",
        "神秘": "深蓝紫暗调",
        "平静": "中性自然色",
    }
    return mapping.get(mood, "中性自然色")


def _infer_sound(mood: str) -> str:
    mapping = {
        "紧张": "低频警报·急促心跳声",
        "温馨": "轻柔钢琴·背景人声",
        "压抑": "沉默·低沉弦乐",
        "激烈": "打击乐·音效爆破",
        "神秘": "环境音·诡异回响",
        "平静": "自然环境音",
    }
    return mapping.get(mood, "自然环境音")


def _infer_camera_move(p_type: str, shot_type: str) -> str:
    if p_type == "action":
        return "跟拍"
    if shot_type in ("远景", "全景"):
        return "慢推"
    if shot_type in ("特写", "大特写"):
        return "静止·缓慢拉近"
    return "固定"


# ─────────────────────────────────────────────
# 5. 角色特征卡生成
# ─────────────────────────────────────────────

def build_character_cards(characters: dict, storyboard: list[dict]) -> list[dict]:
    """生成角色特征卡，含出镜镜头数统计"""
    cards = []
    for name, data in characters.items():
        # 统计该角色出现在哪些镜头
        shot_nos = [s["shot_no"] for s in storyboard if name in s["characters"]]

        # 生成AI绘图提示词关键词
        prompt_keywords = [name]
        prompt_keywords.extend(data.get("appearance_desc", [])[:2])
        prompt_keywords.extend(data.get("personality_desc", [])[:1])

        card = {
            "name": name,
            "total_appearances": data["appearances"],
            "dialogue_count": data["dialogues"],
            "shot_count": len(shot_nos),
            "shot_nos": shot_nos[:10],  # 最多列10条
            "appearance_traits": data.get("appearance_desc", []),
            "personality_traits": data.get("personality_desc", []),
            "sample_dialogues": data.get("sample_lines", [])[:3],
            "ai_prompt_hint": "，".join(prompt_keywords[:5]) + "，电影级写实风格",
        }
        cards.append(card)

    # 按出场次数降序
    cards.sort(key=lambda x: x["total_appearances"], reverse=True)
    return cards


# ─────────────────────────────────────────────
# 6. 场景特征卡生成
# ─────────────────────────────────────────────

def build_scene_cards(scenes: list[dict]) -> list[dict]:
    """生成场景特征卡，含AI场景提示词"""
    cards = []
    for scene in scenes:
        mood_prompts = {
            "紧张": "dramatic tension, high contrast, shallow depth of field",
            "温馨": "warm soft light, golden hour, cozy atmosphere",
            "压抑": "desaturated, dark shadows, oppressive space",
            "激烈": "action shot, motion blur, vibrant colors",
            "神秘": "fog, silhouette, mysterious ambiance, blue tint",
            "平静": "natural light, balanced composition, serene",
        }
        mood = scene["mood"]
        ai_prompt = (
            f"{scene['location_desc'][:50]}，"
            f"{scene['location_type']}，"
            f"{scene['time_of_day']}，"
            f"{_infer_color_tone(mood)}，"
            f"{mood_prompts.get(mood, 'cinematic')}，"
            "8K电影分镜概念图"
        )

        card = {
            "scene_id": scene["id"],
            "header": scene["header"],
            "location_type": scene["location_type"],
            "time_of_day": scene["time_of_day"],
            "mood": mood,
            "color_tone": _infer_color_tone(mood),
            "light": _infer_light(scene["time_of_day"], mood),
            "sound": _infer_sound(mood),
            "characters_present": scene["characters_in_scene"],
            "shot_count": 0,  # 后填充
            "location_desc": scene.get("location_desc", ""),
            "ai_scene_prompt": ai_prompt,
        }
        cards.append(card)
    return cards


# ─────────────────────────────────────────────
# 7. 输出格式化
# ─────────────────────────────────────────────

def format_markdown(
    storyboard: list[dict],
    character_cards: list[dict],
    scene_cards: list[dict],
    source_file: str,
) -> str:
    """生成完整 Markdown 报告"""

    lines = []
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")

    # ── 封面 ──
    lines.append(f"# 分镜脚本报告")
    lines.append(f"\n> 源文件：`{source_file}`  |  生成时间：{ts}")
    lines.append(f"\n---\n")

    # ── 统计摘要 ──
    lines.append(f"## 统计摘要\n")
    lines.append(f"| 指标 | 数量 |")
    lines.append(f"|------|------|")
    lines.append(f"| 总镜头数 | **{len(storyboard)}** |")
    lines.append(f"| 场景数 | **{len(scene_cards)}** |")
    lines.append(f"| 角色数 | **{len(character_cards)}** |")
    lines.append(f"\n---\n")

    # ── 分镜脚本 ──
    lines.append(f"## 分镜脚本\n")

    current_scene_id = None
    for shot in storyboard:
        if shot["scene_id"] != current_scene_id:
            current_scene_id = shot["scene_id"]
            scene_card = next((s for s in scene_cards if s["scene_id"] == current_scene_id), None)
            if scene_card:
                lines.append(f"\n### 场景 {current_scene_id}：{shot['scene_header']}")
                lines.append(f"**地点类型**：{scene_card['location_type']}  "
                             f"**时间**：{scene_card['time_of_day']}  "
                             f"**氛围**：{scene_card['mood']}\n")

        chars = "、".join(shot["characters"]) if shot["characters"] else "无特定角色"
        lines.append(f"#### 镜头 {shot['shot_no']}  `{shot['shot_type']}`")
        lines.append(f"\n| 项目 | 内容 |")
        lines.append(f"|------|------|")
        lines.append(f"| 画面内容 | {shot['content']} |")
        lines.append(f"| 出场角色 | {chars} |")
        lines.append(f"| 摄影机运动 | {shot['camera_move']} |")
        lines.append(f"| 光线 | {shot['light']} |")
        lines.append(f"| 色调 | {shot['color_tone']} |")
        lines.append(f"| 音效/配乐 | {shot['sound']} |")
        if shot["dialogue"]:
            lines.append(f"| 对白 | {shot['dialogue']} |")
        if shot["action_note"]:
            lines.append(f"| 动作提示 | {shot['action_note']} |")
        lines.append("")

    lines.append("---\n")

    # ── 角色特征卡 ──
    lines.append("## 角色特征卡\n")
    for card in character_cards:
        lines.append(f"### {card['name']}")
        lines.append(f"\n| 属性 | 内容 |")
        lines.append(f"|------|------|")
        lines.append(f"| 总出场次数 | {card['total_appearances']} |")
        lines.append(f"| 对白条数 | {card['dialogue_count']} |")
        lines.append(f"| 出镜镜头数 | {card['shot_count']} |")
        if card["appearance_traits"]:
            lines.append(f"| 外貌特征 | {'；'.join(card['appearance_traits'])} |")
        if card["personality_traits"]:
            lines.append(f"| 性格特征 | {'；'.join(card['personality_traits'])} |")
        if card["sample_dialogues"]:
            lines.append(f"| 代表台词 | {'「' + '」；「'.join(card['sample_dialogues']) + '」'} |")
        lines.append(f"| AI 绘图提示词 | `{card['ai_prompt_hint']}` |")
        lines.append("")

    lines.append("---\n")

    # ── 场景特征卡 ──
    lines.append("## 场景特征卡\n")
    for card in scene_cards:
        chars = "、".join(card["characters_present"]) if card["characters_present"] else "无"
        lines.append(f"### 场景 {card['scene_id']}：{card['header']}")
        lines.append(f"\n| 属性 | 内容 |")
        lines.append(f"|------|------|")
        lines.append(f"| 地点类型 | {card['location_type']} |")
        lines.append(f"| 时间 | {card['time_of_day']} |")
        lines.append(f"| 氛围 | {card['mood']} |")
        lines.append(f"| 色调 | {card['color_tone']} |")
        lines.append(f"| 光线 | {card['light']} |")
        lines.append(f"| 音效 | {card['sound']} |")
        lines.append(f"| 出场人物 | {chars} |")
        if card["location_desc"]:
            lines.append(f"| 场景描述 | {card['location_desc']} |")
        lines.append(f"| 场景分镜数 | {card['shot_count']} |")
        lines.append(f"| AI 场景提示词 | `{card['ai_scene_prompt']}` |")
        lines.append("")

    return "\n".join(lines)


def format_json(storyboard, character_cards, scene_cards) -> str:
    """输出 JSON 格式供程序化使用"""
    data = {
        "generated_at": datetime.now().isoformat(),
        "summary": {
            "total_shots": len(storyboard),
            "total_scenes": len(scene_cards),
            "total_characters": len(character_cards),
        },
        "storyboard": storyboard,
        "character_cards": character_cards,
        "scene_cards": scene_cards,
    }
    return json.dumps(data, ensure_ascii=False, indent=2)


# ─────────────────────────────────────────────
# 8. 主入口
# ─────────────────────────────────────────────

def process(input_path: str, output_dir: str = ".", fmt: str = "markdown") -> str:
    """
    主处理函数
    :param input_path: 输入文件路径（.txt / .md）
    :param output_dir:  输出目录
    :param fmt:         输出格式 markdown | json | both
    :return:            生成的主输出文件路径
    """
    # 读取文件
    raw = read_file(input_path)
    text = clean_text(raw)
    source_name = Path(input_path).stem

    # 切分段落
    paragraphs = split_into_paragraphs(text)

    # 提取场景
    scenes = extract_scenes(paragraphs)

    # 提取角色
    characters = extract_characters(text, paragraphs)

    # 生成分镜脚本
    storyboard = generate_storyboard(scenes, characters)

    # 生成角色特征卡
    character_cards = build_character_cards(characters, storyboard)

    # 生成场景特征卡
    scene_cards = build_scene_cards(scenes)

    # 回填场景分镜数
    for sc in scene_cards:
        sc["shot_count"] = sum(1 for s in storyboard if s["scene_id"] == sc["scene_id"])

    # 输出
    os.makedirs(output_dir, exist_ok=True)
    output_files = []

    if fmt in ("markdown", "both"):
        md_content = format_markdown(storyboard, character_cards, scene_cards, source_name)
        md_path = os.path.join(output_dir, f"{source_name}_storyboard.md")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(md_content)
        output_files.append(md_path)
        _safe_print(f"[OK] Markdown 已生成: {md_path}")

    if fmt in ("json", "both"):
        json_content = format_json(storyboard, character_cards, scene_cards)
        json_path = os.path.join(output_dir, f"{source_name}_storyboard.json")
        with open(json_path, "w", encoding="utf-8") as f:
            f.write(json_content)
        output_files.append(json_path)
        _safe_print(f"[OK] JSON 已生成: {json_path}")

    # 控制台摘要
    _safe_print(f"\n[处理完成]")
    _safe_print(f"   总镜头数: {len(storyboard)}")
    _safe_print(f"   场景数: {len(scene_cards)}")
    _safe_print(f"   角色数: {len(character_cards)}")
    for card in character_cards[:5]:
        _safe_print(f"   角色 [{card['name']}] 出场 {card['total_appearances']} 次, {card['dialogue_count']} 条对白")

    return output_files[0] if output_files else ""


def main():
    parser = argparse.ArgumentParser(
        description="小说/剧本文案 → 分镜脚本 + 角色特征 + 场景特征",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  python parse_novel.py input.txt
  python parse_novel.py input.txt -o ./output -f both
  python parse_novel.py input.md --format json
"""
    )
    parser.add_argument("input", help="输入文件路径（.txt 或 .md）")
    parser.add_argument("-o", "--output", default=".", help="输出目录，默认当前目录")
    parser.add_argument("-f", "--format", choices=["markdown", "json", "both"],
                        default="markdown", help="输出格式：markdown | json | both")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"[ERROR] 文件不存在：{args.input}", file=sys.stderr)
        sys.exit(1)

    process(args.input, args.output, args.format)


if __name__ == "__main__":
    main()

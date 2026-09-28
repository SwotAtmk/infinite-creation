import argparse
import html
import re
import sys
from dataclasses import dataclass
from pathlib import Path


STEEL_BLUE = "#4682B4"
KEY_RED = "#FF0000"
TIME_TAGS = "日|夜|清晨|黄昏|傍晚|凌晨|黎明"
SCENE_RE = re.compile(rf"^\d+-\d+\.\s+.+\s+\[(内|外)\]\s+\[({TIME_TAGS})\]$")
EPISODE_RE = re.compile(r"(?:《[^》]+》)?第\d{1,3}集")
DIALOGUE_RE = re.compile(r"^([^：\n]{1,16})：(.*)$")
BLUE_SPAN_RE = re.compile(
    r'<span\b[^>]*style=["\'][^"\']*color\s*:\s*#4682B4[^"\']*["\'][^>]*>(.*?)</span>',
    re.IGNORECASE,
)
RED_SPAN_RE = re.compile(
    r'<span\b[^>]*style=["\'][^"\']*color\s*:\s*#FF0000[^"\']*["\'][^>]*>(.*?)</span>',
    re.IGNORECASE,
)
HALF_WIDTH_PRODUCTION = re.compile(
    r"\[(音效|字幕|特写|景别|运镜|特效|插入闪回|闪回结束|蒙太奇|平行剪辑|本集完)"
)
FORBIDDEN_META = {
    "场景题头",
    "画面/动作",
    "画面/动作(Action)",
    "对白",
    "对白(Dialogue)",
    "特殊音效与视觉",
    "专业术语",
}


@dataclass
class Issue:
    level: str
    line: int
    message: str


def strip_markup(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value)
    value = value.replace("**", "")
    return html.unescape(value).strip()


def is_bold(value: str) -> bool:
    stripped = value.strip()
    return (stripped.startswith("**") and stripped.endswith("**")) or bool(
        re.search(r"<strong\b[^>]*>.*?</strong>", stripped, re.IGNORECASE)
    )


def has_alignment(value: str, direction: str) -> bool:
    return bool(
        re.search(
            rf'<(?:div|p)\b[^>]*align=["\']?{direction}["\']?[^>]*>',
            value,
            re.IGNORECASE,
        )
    )


def terminal_groups(value: str) -> int:
    return len(re.findall(r"[。！？?!]+", value))


def blue_text(value: str) -> str:
    return "".join(strip_markup(match) for match in BLUE_SPAN_RE.findall(value))


def prop_is_red(value: str, prop: str) -> bool:
    return any(prop in strip_markup(match) for match in RED_SPAN_RE.findall(value))


def is_forbidden_meta_line(plain: str) -> bool:
    normalized = plain.strip().strip("【】[]：: ")
    return normalized in FORBIDDEN_META


def analyze(text: str, key_props: list[str]) -> list[Issue]:
    issues: list[Issue] = []
    found_title = False
    found_episode_cast = False
    found_scene = False
    found_scene_cast = False
    found_end = False

    for line_no, original in enumerate(text.splitlines(), 1):
        plain = strip_markup(original)
        if not plain:
            continue

        if is_forbidden_meta_line(plain):
            issues.append(Issue("ERROR", line_no, "最终正文不得输出教学栏目名称"))

        if "(0.S.)" in plain or "(V.0.)" in plain:
            issues.append(Issue("ERROR", line_no, "声音术语中的O必须是英文字母，不能写数字0"))

        if HALF_WIDTH_PRODUCTION.search(plain):
            issues.append(Issue("ERROR", line_no, "制作标记必须使用全角【】，半角方括号只用于场次题头"))

        if EPISODE_RE.search(plain):
            found_title = True
            if not is_bold(original):
                issues.append(Issue("ERROR", line_no, "集标题必须加粗"))
            if not has_alignment(original, "center"):
                issues.append(Issue("WARN", line_no, "富文本集标题应居中"))
            continue

        if plain.startswith("本集人物："):
            found_episode_cast = True
            if not is_bold(original):
                issues.append(Issue("ERROR", line_no, "本集人物总表必须加粗"))
            continue

        if SCENE_RE.match(plain):
            found_scene = True
            if not is_bold(original):
                issues.append(Issue("ERROR", line_no, "场次题头必须加粗"))
            continue

        if re.match(r"^\d+-\d+\.", plain) and not SCENE_RE.match(plain):
            issues.append(Issue("ERROR", line_no, "场次题头应为：1-1. 地点 [内] [夜]"))
            continue

        if plain.startswith("人物："):
            found_scene_cast = True
            if not is_bold(original):
                issues.append(Issue("ERROR", line_no, "逐场人物表必须加粗"))
            continue

        if plain == "【本集完】":
            found_end = True
            if not has_alignment(original, "right"):
                issues.append(Issue("WARN", line_no, "富文本中的【本集完】应右对齐"))
            continue

        if "【字幕" in plain:
            if STEEL_BLUE.lower() not in original.lower():
                issues.append(Issue("ERROR", line_no, "字幕标记和字幕内容必须使用钢蓝色#4682B4"))

        if plain.startswith("△"):
            if terminal_groups(plain) > 1:
                issues.append(Issue("ERROR", line_no, "动作句应每个完整句子单独换行"))
        elif plain.startswith("【") and plain.endswith("】"):
            pass
        else:
            dialogue = DIALOGUE_RE.match(plain)
            if dialogue:
                speaker, content = dialogue.groups()
                if is_bold(original):
                    issues.append(Issue("ERROR", line_no, "正文对白人物名和对白不得加粗"))
                if "“" not in content or "”" not in content:
                    issues.append(Issue("ERROR", line_no, "每句台词必须使用中文双引号标明始末"))
                if terminal_groups(content) > 1:
                    issues.append(Issue("ERROR", line_no, "每个完整台词句子必须单独换行并重复人物名"))
                colored = blue_text(original)
                if f"{speaker}：" not in colored or "“" not in colored or "”" not in colored:
                    issues.append(Issue("ERROR", line_no, "对白人物名、冒号、引号和台词必须使用钢蓝色#4682B4"))
                for token in ("(O.S.)", "(V.O.)"):
                    if token in plain and token not in colored:
                        issues.append(Issue("ERROR", line_no, f"{token}必须使用钢蓝色#4682B4"))
            elif not plain.startswith(("<", "<!--")):
                issues.append(Issue("WARN", line_no, "未识别行：动作应以△开头，对白应使用人物名：格式"))

        for prop in key_props:
            if prop in plain and not prop_is_red(original, prop):
                issues.append(Issue("ERROR", line_no, f"关键道具“{prop}”的每次出现都必须使用红色#FF0000"))

    if not found_title:
        issues.append(Issue("ERROR", 0, "缺少集标题"))
    if not found_episode_cast:
        issues.append(Issue("ERROR", 0, "缺少集前本集人物总表"))
    if not found_scene:
        issues.append(Issue("ERROR", 0, "缺少合法场次题头"))
    if not found_scene_cast:
        issues.append(Issue("ERROR", 0, "缺少逐场人物表"))
    if not found_end:
        issues.append(Issue("ERROR", 0, "缺少【本集完】"))
    return issues


def run_self_test() -> int:
    valid = """<div align="center"><strong>《测试剧》第01集</strong></div>
**本集人物：陈墨，周启**
**1-1. 废弃仓库 [内] [夜]**
**人物：陈墨，周启**
△陈墨推开生锈的铁门。
<span style="color:#4682B4">陈墨：</span>（冷笑）<span style="color:#4682B4">“你以为你能跑？”</span>
<span style="color:#4682B4">【字幕：三分钟前】</span>
△周启把<span style="color:#FF0000">黑色钥匙</span>攥进掌心。
<div align="right">【本集完】</div>"""
    invalid = """第1集
人物：陈墨
1-1仓库[内][夜]
A陈墨害怕。
**陈墨：你别来。**
[字幕]三分钟前
【本集完】"""
    valid_issues = analyze(valid, ["黑色钥匙"])
    invalid_issues = analyze(invalid, [])
    valid_errors = [issue for issue in valid_issues if issue.level == "ERROR"]
    invalid_errors = [issue for issue in invalid_issues if issue.level == "ERROR"]
    if valid_errors or not invalid_errors:
        print("SELF-TEST FAILED")
        for issue in valid_issues:
            print(issue)
        return 1
    print(f"SELF-TEST PASSED: invalid sample produced {len(invalid_errors)} expected errors")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="检查0715编剧Skill的剧本硬格式")
    parser.add_argument("file", nargs="?", help="UTF-8 Markdown、HTML或文本剧本")
    parser.add_argument("--key-prop", action="append", default=[], help="必须全程标红的关键道具，可重复")
    parser.add_argument("--self-test", action="store_true", help="运行内置自测")
    args = parser.parse_args()

    if args.self_test:
        return run_self_test()
    if not args.file:
        parser.error("需要剧本文件，或使用 --self-test")

    path = Path(args.file)
    text = path.read_text(encoding="utf-8-sig")
    issues = analyze(text, args.key_prop)
    for issue in issues:
        location = f"line {issue.line}" if issue.line else "document"
        print(f"{issue.level} {location}: {issue.message}")
    errors = sum(issue.level == "ERROR" for issue in issues)
    warnings = sum(issue.level == "WARN" for issue in issues)
    print(f"SUMMARY errors={errors} warnings={warnings}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())

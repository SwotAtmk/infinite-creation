#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
multi_search.py — 多搜索引擎聚合检索（零第三方依赖）

配合 multi-search-engine 技能使用。仅依赖 Python 3.7+ 标准库。

两种模式：
  1. 链接模式（默认，不发起网络请求）：为选定引擎生成可点击的搜索链接，任何环境都可用。
  2. 抓取模式（--fetch）：以浏览器身份请求公开搜索页，尽力提取标题与链接，
     跨引擎去重后输出 Markdown / JSON 报告。单引擎失败不影响其他引擎。

安全与合规：
  - 只访问公开的搜索引擎结果页，不需要任何 API Key；
  - Cookie 仅在单个引擎的一次检索过程中暂存于内存（遇 403/429 时访问首页建立会话后
    重试一次），不读写磁盘、会话结束即丢弃，不模拟登录；
  - 顺序请求、请求间隔默认 1.5 秒、单引擎最多重试 1 次，不绕过验证码；
  - 默认不写文件，仅当显式传入 --output 时才保存报告。

示例（Windows 用 python，macOS/Linux 可用 python3）：
  python multi_search.py --list-engines
  python multi_search.py "Python 教程"
  python multi_search.py "react hooks" -e bing-cn,baidu --fetch
  python multi_search.py "AI 新闻" --cn --time d --json
  python multi_search.py "site:github.com transformer" -e google --fetch
"""

import argparse
import base64
import datetime as _dt
import gzip
import http.cookiejar
import html as _html
import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

# Windows 控制台 UTF-8 输出（Python 3.7+）
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# 跟踪参数：去重时丢弃，避免同一页面被识别成不同结果
TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "spm", "from", "isappinstalled", "ie", "f",
    "rsv_bp", "rsv_sug3", "oq",
}

# 引擎注册表：抓取方式经过 2026 年可用性核对
# access: direct=中国大陆可直连  intl=需国际网络环境
# antibot: low/med/high 表示公开结果页对非浏览器抓取的友好程度
ENGINES = {
    # ---------- 国内 7 ----------
    "bing-cn": {
        "name": "必应中国", "group": "cn", "access": "direct", "antibot": "low",
        "best": "综合网页、英文资料国内直出，抓取成功率最高，默认首选",
        "url": "https://cn.bing.com/search?q={q}&ensearch=0",
    },
    "bing-int": {
        "name": "必应国际版(国内入口)", "group": "cn", "access": "direct", "antibot": "low",
        "best": "在大陆直连获取国际结果，无需国际网络",
        "url": "https://cn.bing.com/search?q={q}&ensearch=1",
    },
    "baidu": {
        "name": "百度", "group": "cn", "access": "direct", "antibot": "high",
        "best": "中文资讯、百家号、贴吧、国内长尾信息",
        "url": "https://www.baidu.com/s?wd={q}&rn=10",
    },
    "so360": {
        "name": "360搜索", "group": "cn", "access": "direct", "antibot": "med",
        "best": "中文资讯、问答内容交叉验证",
        "url": "https://www.so.com/s?q={q}",
    },
    "sogou": {
        "name": "搜狗", "group": "cn", "access": "direct", "antibot": "med",
        "best": "微信/知乎内容收录、微信公众号文章(配合 weixin 引擎)",
        "url": "https://www.sogou.com/web?query={q}",
    },
    "weixin": {
        "name": "微信搜索", "group": "cn", "access": "direct", "antibot": "high",
        "best": "微信公众号文章，频繁请求会出现验证码",
        "url": "https://weixin.sogou.com/weixin?type=2&query={q}",
    },
    "shenma": {
        "name": "神马搜索", "group": "cn", "access": "direct", "antibot": "med",
        "best": "移动视角的中文长尾内容(UC/阿里系)",
        "url": "https://m.sm.cn/s?q={q}",
    },
    # ---------- 国际 9 ----------
    "duckduckgo": {
        "name": "DuckDuckGo", "group": "global", "access": "intl", "antibot": "low",
        "best": "隐私无追踪、无埋点，html/lite 无 JS 端点结构稳定，国际环境首选",
        "url": "https://html.duckduckgo.com/html/?q={q}",
        "fetch": {"method": "POST", "post_url": "https://html.duckduckgo.com/html/",
                  "fallback": "https://lite.duckduckgo.com/lite/?q={q}"},
    },
    "google": {
        "name": "Google", "group": "global", "access": "intl", "antibot": "med",
        "best": "英文技术资料、官方文档、学术资源覆盖面最广",
        "url": "https://www.google.com/search?q={q}",
        "fetch_url": "https://www.google.com/search?q={q}&gbv=1&num=10",
    },
    "google-hk": {
        "name": "Google香港", "group": "global", "access": "intl", "antibot": "med",
        "best": "Google 备用入口，中文结果权重略高",
        "url": "https://www.google.com.hk/search?q={q}",
        "fetch_url": "https://www.google.com.hk/search?q={q}&gbv=1&num=10",
    },
    "ecosia": {
        "name": "Ecosia", "group": "global", "access": "intl", "antibot": "low",
        "best": "基于 Bing 索引，反爬宽松，Google 不可用时的国际平替",
        "url": "https://www.ecosia.org/search?q={q}",
    },
    "yahoo": {
        "name": "Yahoo", "group": "global", "access": "intl", "antibot": "med",
        "best": "英文/日文资讯、老站收录",
        "url": "https://search.yahoo.com/search?p={q}",
    },
    "startpage": {
        "name": "Startpage", "group": "global", "access": "intl", "antibot": "high",
        "best": "Google 结果源 + 隐私保护，抓取常被拦截",
        "url": "https://www.startpage.com/sp/search?query={q}",
    },
    "brave": {
        "name": "Brave", "group": "global", "access": "intl", "antibot": "high",
        "best": "独立索引、技术社区内容，需完整浏览器指纹，脚本成功率低",
        "url": "https://search.brave.com/search?q={q}",
    },
    "qwant": {
        "name": "Qwant", "group": "global", "access": "intl", "antibot": "high",
        "best": "欧盟隐私引擎，脚本成功率低，建议浏览器使用",
        "url": "https://www.qwant.com/?q={q}",
    },
    "wolframalpha": {
        "name": "WolframAlpha", "group": "global", "access": "intl", "antibot": "med",
        "best": "数学计算、单位换算、汇率、日期等结构化知识(非网页检索)",
        "url": "https://www.wolframalpha.com/input?i={q}",
        "extract": False,
    },
}

# 垂直站点（第 17+ 个“加分项”，不计入 16 引擎承诺，适合定向检索）
VERTICAL_ENGINES = {
    "github": ("GitHub", "https://github.com/search?q={q}&type=repositories"),
    "stackoverflow": ("Stack Overflow", "https://stackoverflow.com/search?q={q}"),
    "zhihu": ("知乎", "https://www.zhihu.com/search?type=content&q={q}"),
    "bilibili": ("哔哩哔哩", "https://search.bilibili.com/all?keyword={q}"),
    "toutiao": ("今日头条", "https://so.toutiao.com/search?keyword={q}"),
    "juejin": ("掘金", "https://juejin.cn/search?query={q}"),
    "scholar": ("Google学术", "https://scholar.google.com/scholar?q={q}"),
    "baiduxs": ("百度学术", "https://xueshu.baidu.com/s?wd={q}"),
    "weibo": ("微博", "https://s.weibo.com/weibo?q={q}"),
}

# Google 系时间过滤（tbs=qdr）
TIME_CODES = {"h": "qdr:h", "d": "qdr:d", "w": "qdr:w", "m": "qdr:m", "y": "qdr:y"}

CN_DEFAULT = ["bing-cn", "baidu", "sogou"]
GLOBAL_DEFAULT = ["duckduckgo", "google", "ecosia"]


def build_url(engine_id, query, time_code=None):
    """根据引擎模板生成搜索链接（链接模式与抓取模式共用）。"""
    if engine_id in ENGINES:
        tpl = ENGINES[engine_id]["url"]
    else:
        tpl = VERTICAL_ENGINES[engine_id][1]
    q = urllib.parse.quote(query, safe=":=")
    url = tpl.format(q=q)
    if time_code and engine_id in ("google", "google-hk"):
        url += "&tbs=" + TIME_CODES[time_code]
    elif time_code and engine_id == "sogou":
        url += "&tsn=" + {"d": "1", "w": "2", "m": "3", "y": "4"}[time_code]
    elif time_code and engine_id == "duckduckgo":
        url += "&df=" + time_code
    return url


# ------------------------- 抓取与解析 -------------------------

class _AnchorParser(HTMLParser):
    """收集页面中的 <a href> 及其内部文字。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.anchors = []
        self._href = None
        self._text = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            t = data.strip()
            if t:
                self._text.append(t)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            title = " ".join(self._text).strip()
            if title:
                self.anchors.append((self._href, title))
            self._href = None
            self._text = []


def _decode(body, headers):
    """gzip 解压 + 编码探测。"""
    if headers.get("Content-Encoding", "") == "gzip":
        body = gzip.GzipFile(fileobj=io.BytesIO(body)).read()
    charset = headers.get_content_charset()
    for enc in (charset, "utf-8", "gb18030"):
        if not enc:
            continue
        try:
            return body.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return body.decode("utf-8", errors="replace")


def new_session():
    """新建一个仅存活于单次引擎检索的内存 Cookie 会话（不写入磁盘）。"""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return opener, jar


def http_get(url, timeout, opener=None):
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip",
    })
    _open = opener.open if opener is not None else urllib.request.urlopen
    with _open(req, timeout=timeout) as resp:
        return resp.status, _decode(resp.read(), resp.headers), resp.geturl()


def http_post(url, data, timeout, opener=None):
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip",
        "Origin": "https://html.duckduckgo.com",
        "Referer": "https://html.duckduckgo.com/",
    })
    _open = opener.open if opener is not None else urllib.request.urlopen
    with _open(req, timeout=timeout) as resp:
        return resp.status, _decode(resp.read(), resp.headers), resp.geturl()


def unwrap_ddg(href):
    """把 duckduckgo.com/l/?uddg=<真实URL> 还原成目标地址。"""
    if "duckduckgo.com/l/" in href:
        qs = urllib.parse.urlparse(href).query
        uddg = urllib.parse.parse_qs(qs).get("uddg", [""])[0]
        if uddg:
            return uddg
    return href


def unwrap_bing(href):
    """把 bing.com/ck/a?...&u=a1<base64url> 跳转链接还原成目标地址。"""
    if "bing.com/ck/a" in href:
        u = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("u", [""])[0]
        if u.startswith("a1"):
            raw = u[2:]
            raw += "=" * (-len(raw) % 4)
            try:
                return base64.urlsafe_b64decode(raw).decode("utf-8")
            except Exception:
                return href
    return href


def unwrap_yahoo(href):
    """Yahoo 跳转链接 r.search.yahoo.com 路径段中的 RU=<真实URL> 还原。"""
    if "r.search.yahoo.com/" in href and "/RU=" in href:
        tail = href.split("/RU=", 1)[1]
        target = tail.split("/", 1)[0]
        if target:
            return urllib.parse.unquote(target)
    return href


def unwrap_google(href):
    """Google 基础版 /url?q=<目标>&sa=... 跳转还原。"""
    if href.startswith("/url?") or href.startswith("https://www.google.com/url?") \
            or href.startswith("https://www.google.com.hk/url?"):
        qs = href.split("?", 1)[1]
        target = urllib.parse.parse_qs(qs).get("q", [""])[0]
        if target:
            return target
    return href


# 各引擎自身域名 + 允许保留的结果跳转路径
_OWN_HOSTS = {
    "bing-cn": {"cn.bing.com", "www.bing.com", "bing.com"},
    "bing-int": {"cn.bing.com", "www.bing.com", "bing.com"},
    "baidu": {"www.baidu.com", "baidu.com"},
    "so360": {"www.so.com", "so.com"},
    "sogou": {"www.sogou.com", "sogou.com"},
    "shenma": {"m.sm.cn", "sm.cn", "lmda.sm.cn"},
    "weixin": {"weixin.sogou.com", "www.sogou.com"},
    "duckduckgo": {"duckduckgo.com", "html.duckduckgo.com", "lite.duckduckgo.com"},
    "google": {"www.google.com", "google.com"},
    "google-hk": {"www.google.com.hk", "google.com.hk"},
    "ecosia": {"www.ecosia.org", "ecosia.org"},
    "yahoo": {"search.yahoo.com", "yahoo.com", "r.search.yahoo.com"},
    "startpage": {"www.startpage.com", "startpage.com"},
    "brave": {"search.brave.com", "brave.com"},
    "qwant": {"www.qwant.com", "qwant.com"},
}

# 站内域名下这些路径是“结果跳转”，保留；其余站内链接视为导航/垂直页丢弃
_WRAPPER_PATHS = ("/link?", "/ck/a", "/url?", "/l/?", "/RU=", "/jump")


def is_internal_nav(engine_id, url):
    host = urllib.parse.urlparse(url).netloc.lower()
    if host not in _OWN_HOSTS.get(engine_id, set()):
        return False
    pathq = urllib.parse.urlparse(url).path + "?" + urllib.parse.urlparse(url).query
    return not any(w in pathq for w in _WRAPPER_PATHS)


def is_result_link(engine_id, href, title):
    if not href or len(title) < 6:
        return False
    href = href.strip()
    low = href.lower()
    if low.startswith(("javascript:", "#", "mailto:")):
        return False
    # 明确保留的引擎跳转链接
    if engine_id == "baidu" and "baidu.com/link?url=" in low:
        return True
    if engine_id in ("so360", "sogou", "shenma") and ("/link?" in low or "/jump" in low):
        return True
    if engine_id == "weixin" and "mp.weixin.qq.com" in low:
        return True
    if low.startswith("http"):
        host = urllib.parse.urlparse(href).netloc.lower()
        own_hosts = _OWN_HOSTS.get(engine_id, set())
        if host not in own_hosts:
            return True
        # 站内但属于结果跳转链接
        if "baidu.com/link?url=" in low or "bing.com/ck/a" in low:
            return True
    return False


def normalize_url(url):
    """URL 规范化用于去重。"""
    try:
        p = urllib.parse.urlparse(url)
        host = p.netloc.lower().replace("www.", "")
        qs = [(k, v) for k, v in urllib.parse.parse_qsl(p.query)
              if k.lower() not in TRACKING_PARAMS]
        path = p.path.rstrip("/")
        query = urllib.parse.urlencode(sorted(qs))
        return urllib.parse.urlunparse((p.scheme.lower(), host, path, "", query, ""))
    except Exception:
        return url


# ------------------------- 搜索引擎专属解析 -------------------------
# 各主流引擎的结果块结构不同，精准提取 <h2>/<h3> 标题锚点，
# 避免把面包屑、<cite> 域名、导航链接误当成结果。

def _clean_text(raw):
    text = re.sub(r"<[^>]+>", "", raw)
    text = _html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    # 去掉引擎追加在标题尾部的域名展示，如 "教程 — www.baidu.com"
    text = re.sub(r"\s+[—–\-|]\s*(?:https?://)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$",
                  "", text, flags=re.I)
    return text.strip(" —–-|")


# 推荐搜索/广告块等非结果标题噪声
_NOISE_TITLES = ("其他人还搜", "相关搜索", "进一步探索", "更多相关", "查看全部",
                 "大家还在搜", "为您推荐")

# 广告/点击监测中转域名（非真实内容页）
_TRACKER_HOSTS = {"e.so.com", "p.baidu.com", "pos.baidu.com", "e.baidu.com"}


def is_noise(title, href):
    if any(n in title for n in _NOISE_TITLES):
        return True
    try:
        if urllib.parse.urlparse(href).netloc.lower() in _TRACKER_HOSTS:
            return True
    except Exception:
        return True
    return False


def _take(patterns, page, limit):
    """按一组 (href_group, title_group) 正则依次提取，命中即返回。"""
    out, seen = [], set()
    for pat in patterns:
        for m in re.finditer(pat, page, flags=re.S | re.I):
            href, title = m.group(1), _clean_text(m.group(2))
            if not href or len(title) < 4 or is_noise(title, href):
                continue
            key = normalize_url(href)
            if key in seen:
                continue
            seen.add(key)
            out.append({"title": title, "url": href})
            if len(out) >= limit:
                return out
        if out:
            return out
    return out


def extract_bing(page, limit):
    # <li class="b_algo"><h2><a href="真实链接或 ck/a 跳转">标题</a></h2>
    return _take([r'<h2[^>]*>\s*<a\b[^>]*?href="([^"]+)"[^>]*>(.*?)</a>'], page, limit)


def extract_h3_anchor(page, limit):
    """百度/360/搜狗/Yahoo：解析 h3 内首个 a 标签。

    360 把真实地址放在 data-mdurl 属性，href 是 /link 中转，优先取 data-mdurl。
    """
    out, seen = [], set()
    for block in re.finditer(r"<h3[^>]*>(.*?)</h3>", page, flags=re.S | re.I):
        am = re.search(r"<a\b([^>]*)>(.*?)</a>", block.group(1), flags=re.S | re.I)
        if not am:
            continue
        attrs, inner = am.group(1), am.group(2)
        hm = re.search(r'href="([^"]+)"', attrs)
        if not hm:
            continue
        href = hm.group(1)
        md = re.search(r'data-mdurl="([^"]+)"', attrs)
        if md and md.group(1).startswith("http"):
            href = _html.unescape(md.group(1))
        title = _clean_text(inner)
        if len(title) < 4 or is_noise(title, href):
            continue
        key = normalize_url(href)
        if key in seen:
            continue
        seen.add(key)
        out.append({"title": title, "url": href})
        if len(out) >= limit:
            break
    return out


def extract_ddg(page, limit):
    out, seen = [], set()
    for m in re.finditer(r'<a\b([^>]*class="result__a"[^>]*)>(.*?)</a>', page, flags=re.S):
        attrs, inner = m.group(1), m.group(2)
        hm = re.search(r'href="([^"]+)"', attrs)
        if not hm:
            continue
        href, title = hm.group(1), _clean_text(inner)
        if len(title) < 4:
            continue
        key = normalize_url(href)
        if key in seen:
            continue
        seen.add(key)
        out.append({"title": title, "url": href})
        if len(out) >= limit:
            break
    return out


def extract_google(page, limit):
    # 基础版：<a href="..."><h3>标题</h3></a>（href 可能是 /url?q= 跳转）
    return _take([r'<a\b[^>]*?href="([^"]+)"[^>]*>(?:(?!</a>).)*?<h3[^>]*>(.*?)</h3>'],
                 page, limit)


def extract_weixin(page, limit):
    return _take([r'<a\b[^>]*?href="(https://mp\.weixin\.qq\.com/[^"]+)"[^>]*>(.*?)</a>'],
                 page, limit)


def extract_github(page, limit):
    # 仓库搜索结果链接（2025+ 新版 search-title 结构 / 旧版 v-align-middle）
    return _take([
        r'class="search-title[^"]*"[^>]*>\s*<a\b[^>]*?href="(/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)"[^>]*>(.*?)</a>',
        r'<a\b[^>]*?data-testid="results-list-item-title"[^>]*?href="(/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)"[^>]*>(.*?)</a>',
        r'<a\b[^>]*?class="v-align-middle"[^>]*?href="(/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)"[^>]*>(.*?)</a>',
    ], page, limit)


# 引擎 → 专属解析器；未列出的引擎退回全页锚点扫描
_EXTRACTORS = {
    "bing-cn": extract_bing, "bing-int": extract_bing,
    "baidu": extract_h3_anchor, "so360": extract_h3_anchor,
    "sogou": extract_h3_anchor, "yahoo": extract_h3_anchor,
    "stackoverflow": extract_h3_anchor,
    "duckduckgo": extract_ddg,
    "google": extract_google, "google-hk": extract_google,
    "weixin": extract_weixin, "github": extract_github,
}


def extract_results(engine_id, page_html, limit):
    parser_fn = _EXTRACTORS.get(engine_id)
    if parser_fn is not None:
        raw = parser_fn(page_html, limit)
    else:
        parser = _AnchorParser()
        try:
            parser.feed(page_html)
        except Exception:
            pass
        raw = [{"title": t, "url": h} for h, t in parser.anchors
               if is_result_link(engine_id, h, t)][:limit]
    out, seen = [], set()
    for item in raw:
        href = item["url"].strip()
        if href.startswith("//"):
            href = "https:" + href
        elif href.startswith("/"):
            base = ENGINES[engine_id]["url"] if engine_id in ENGINES \
                else VERTICAL_ENGINES[engine_id][1]
            href = urllib.parse.urljoin(base, href)
        href = unwrap_yahoo(href)
        href = unwrap_ddg(href)
        href = unwrap_bing(href)
        href = unwrap_google(href)
        href = _html.unescape(href)
        title = _html.unescape(re.sub(r"\s+", " ", item["title"]))
        if is_noise(title, href) or is_internal_nav(engine_id, href):
            continue
        key = normalize_url(href)
        if key in seen:
            continue
        seen.add(key)
        out.append({"title": title, "url": href})
        if len(out) >= limit:
            break
    return out


# ------------------------- DDG 摘要（结构稳定，单独解析） -------------------------

def extract_ddg_snippets(page_html):
    """DuckDuckGo html 端点的摘要文本，按出现顺序返回，供报告补充。"""
    return [_html.unescape(re.sub(r"<[^>]+>", "", s)).strip()
            for s in re.findall(r'class="result__snippet"[^>]*>(.*?)</a>',
                                page_html, flags=re.S)][:10]


# ------------------------- 引擎执行 -------------------------

def _do_request(engine_id, fetch_tpl, post_cfg, query, q, args, opener):
    """用给定会话执行一次检索请求，返回页面 HTML。"""
    url = fetch_tpl.format(q=q)
    if post_cfg and post_cfg.get("method") == "POST":
        data = {"q": query}
        if args.time:
            data["df"] = args.time
        try:
            _, page, _ = http_post(post_cfg["post_url"], data, args.timeout, opener)
        except Exception:
            _, page, _ = http_get(post_cfg["fallback"].format(q=q), args.timeout, opener)
        return page
    return http_get(url, args.timeout, opener)[1]


def search_one(engine_id, query, args):
    """抓取单个引擎，返回 (results, error)。

    会话管理（对齐原始工作流）：每个引擎使用独立的内存 CookieJar；
    首次请求遇 403/418/429/503 时，先 GET 一次引擎首页建立会话，
    等待 2 秒后仅重试 1 次。Cookie 不落盘、函数返回即丢弃。
    """
    if engine_id in ENGINES:
        meta = ENGINES[engine_id]
        fetch_tpl = meta.get("fetch_url", meta["url"])
        post_cfg = meta.get("fetch")
        req_host_url = post_cfg["post_url"] if post_cfg else fetch_tpl
    else:  # 垂直站点
        meta, post_cfg = {"group": "vertical"}, None
        fetch_tpl = VERTICAL_ENGINES[engine_id][1]
        req_host_url = fetch_tpl
    q = urllib.parse.quote(query, safe=":=")
    if args.time and engine_id in ("google", "google-hk"):
        fetch_tpl += "&tbs=" + TIME_CODES[args.time]

    opener, _jar = new_session()
    try:
        page = _do_request(engine_id, fetch_tpl, post_cfg, query, q, args, opener)
    except urllib.error.HTTPError as e:
        if e.code not in (403, 418, 429, 503):
            return [], f"HTTP {e.code}"
        # 会话预热：访问同站首页获取会话 Cookie，2 秒后重试一次
        home = urllib.parse.urlparse(req_host_url)
        home_url = f"{home.scheme}://{home.netloc}/"
        try:
            http_get(home_url, args.timeout, opener)
            time.sleep(2)
            page = _do_request(engine_id, fetch_tpl, post_cfg, query, q, args, opener)
        except urllib.error.HTTPError as e2:
            return [], f"HTTP {e2.code}（会话预热后仍被拦截，建议换引擎或改用链接模式）"
        except (urllib.error.URLError, TimeoutError, OSError) as e2:
            return [], f"HTTP {e.code} 后会话预热失败（{type(e2).__name__}），建议换引擎"
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return [], f"网络不可达/超时（{type(e).__name__}；该引擎可能需国际网络）"

    low = page.lower()
    if any(k in low for k in ("captcha", "/sorry/", "验证", "人机校验")) and len(low) < 6000:
        return [], "出现验证码/人机校验，已按规范停止抓取"
    results = extract_results(engine_id, page, args.limit)
    if not results:
        return [], "页面已返回但未解析到结果（结构变化或地区重定向）"
    if engine_id == "duckduckgo":
        snippets = extract_ddg_snippets(page)
        for i, r in enumerate(results):
            if i < len(snippets):
                r["snippet"] = snippets[i]
    return results, None


def merge_results(per_engine):
    """跨引擎合并去重，多源命中的结果排名靠前。"""
    merged = {}
    order = []
    for engine_id, results in per_engine:
        for rank, r in enumerate(results):
            key = normalize_url(r["url"])
            if key not in merged:
                merged[key] = {
                    "title": r["title"], "url": r["url"],
                    "engines": [engine_id], "best_rank": rank,
                    "snippet": r.get("snippet", ""),
                }
                order.append(key)
            else:
                if engine_id not in merged[key]["engines"]:
                    merged[key]["engines"].append(engine_id)
                merged[key]["best_rank"] = min(merged[key]["best_rank"], rank)
                if not merged[key]["snippet"] and r.get("snippet"):
                    merged[key]["snippet"] = r["snippet"]
    items = [merged[k] for k in order]
    items.sort(key=lambda x: (-len(x["engines"]), x["best_rank"]))
    return items


# ------------------------- 输出 -------------------------

def engine_label(eid):
    if eid in ENGINES:
        return ENGINES[eid]["name"]
    return VERTICAL_ENGINES[eid][0]


def render_markdown(query, engine_ids, attempted, failures, merged, link_urls, fetched):
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = ["# 多引擎搜索报告", "",
             f"- 查询词：`{query}`", f"- 生成时间：{now}",
             f"- 模式：{'抓取聚合' if fetched else '链接生成（未发起网络请求）'}"]
    ok = [f"{engine_label(e)}({e})" for e, ok_ in attempted if ok_]
    bad = [f"{engine_label(e)}({e}): {reason}" for e, reason in failures]
    lines.append(f"- 成功引擎：{', '.join(ok) if ok else '无'}")
    if bad:
        lines.append(f"- 失败引擎：{'; '.join(bad)}")
    lines.append("")
    if fetched:
        lines.append(f"## 去重后结果（共 {len(merged)} 条，多源命中优先）")
        for i, r in enumerate(merged, 1):
            host = urllib.parse.urlparse(r["url"]).netloc
            src = ", ".join(engine_label(e) for e in r["engines"])
            lines.append(f"{i}. **{r['title']} — {host}**")
            lines.append(f"   - 链接：{r['url']}")
            lines.append(f"   - 来源：{src}")
            if r.get("snippet"):
                lines.append(f"   - 摘要：{r['snippet'][:200]}")
        lines.append("")
    lines.append("## 各引擎搜索链接（点击即可在浏览器查看完整结果）")
    lines.append("| 引擎 | 链接 |")
    lines.append("|---|---|")
    for eid in engine_ids:
        lines.append(f"| {engine_label(eid)} | {link_urls[eid]} |")
    lines.append("")
    return "\n".join(lines)


def render_json(query, attempted, failures, merged, link_urls, fetched):
    return {
        "query": query,
        "mode": "fetch" if fetched else "links",
        "searched_at": _dt.datetime.now().isoformat(timespec="seconds"),
        "engines_ok": [e for e, ok_ in attempted if ok_],
        "engines_failed": [{"engine": e, "reason": why} for e, why in failures],
        "result_count": len(merged),
        "results": [
            {"rank": i, "title": r["title"], "url": r["url"],
             "engines": r["engines"], "snippet": r.get("snippet", "")}
            for i, r in enumerate(merged, 1)
        ],
        "search_links": link_urls,
    }


# ------------------------- CLI -------------------------

def resolve_engine_ids(args):
    all_cn = [e for e, m in ENGINES.items() if m["group"] == "cn"]
    all_global = [e for e, m in ENGINES.items() if m["group"] == "global"]
    if args.all:
        engine_ids = list(ENGINES.keys())
    elif args.cn:
        engine_ids = all_cn
    elif args.global_:
        engine_ids = all_global
    elif args.engines:
        engine_ids = [e.strip() for e in args.engines.split(",") if e.strip()]
    else:
        engine_ids = CN_DEFAULT
    if args.vertical:
        engine_ids += [v.strip() for v in args.vertical.split(",") if v.strip()]
    unknown = [e for e in engine_ids if e not in ENGINES and e not in VERTICAL_ENGINES]
    if unknown:
        sys.exit(f"未知引擎: {', '.join(unknown)}；用 --list-engines 查看全部引擎")
    # 链接模式允许 wolframalpha；抓取模式它无结果解析
    return engine_ids


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="多搜索引擎聚合检索（零依赖，支持链接模式与抓取模式）")
    parser.add_argument("query", nargs="?", help="搜索关键词（可用 site:/filetype: 等操作符）")
    parser.add_argument("-e", "--engines", help="引擎 id 逗号分隔，如 bing-cn,baidu,duckduckgo")
    parser.add_argument("--cn", action="store_true", help="使用全部 7 个国内引擎")
    parser.add_argument("--global", dest="global_", action="store_true", help="使用全部 9 个国际引擎")
    parser.add_argument("--all", action="store_true", help="使用全部 16 个引擎")
    parser.add_argument("--vertical", help="追加垂直站点：github,zhihu,bilibili,scholar 等")
    parser.add_argument("--time", choices=list(TIME_CODES), help="时间范围 h/d/w/m/y（google/sogou/ddg 生效）")
    parser.add_argument("--fetch", action="store_true", help="抓取搜索页并提取结果（默认仅生成链接）")
    parser.add_argument("--limit", type=int, default=8, help="每个引擎最多提取条数，默认 8")
    parser.add_argument("--delay", type=float, default=1.5, help="抓取请求间隔秒数，默认 1.5")
    parser.add_argument("--timeout", type=float, default=10.0, help="单请求超时秒数，默认 10")
    parser.add_argument("--json", action="store_true", help="输出 JSON 而非 Markdown")
    parser.add_argument("--output", help="将报告保存到指定文件（默认只打印到标准输出）")
    parser.add_argument("--list-engines", action="store_true", help="列出全部引擎后退出")
    args = parser.parse_args(argv)

    if args.list_engines:
        print("== 16 个核心搜索引擎 ==")
        for eid, m in ENGINES.items():
            tag = "国内" if m["group"] == "cn" else "国际"
            net = "大陆直连" if m["access"] == "direct" else "需国际网络"
            print(f"  {eid:13s} [{tag}|{net}|反爬{m['antibot']}] {m['name']}：{m['best']}")
        print("\n== 垂直站点（通过 --vertical 追加）==")
        for eid, (name, _) in VERTICAL_ENGINES.items():
            print(f"  {eid:13s} {name}")
        print("\n默认国内组合：" + ",".join(CN_DEFAULT))
        print("默认国际组合：" + ",".join(GLOBAL_DEFAULT))
        return 0

    if not args.query or not args.query.strip():
        parser.error("查询词为空（仅空格也视为空），请提供有效关键词")
    if args.limit < 1:
        parser.error("--limit 必须为正整数（1-50），当前为 %s" % args.limit)
    if args.timeout <= 0:
        parser.error("--timeout 必须大于 0（秒），当前为 %s" % args.timeout)
    if args.delay < 0:
        parser.error("--delay 不能为负数，当前为 %s" % args.delay)
    if len(urllib.parse.quote(args.query, safe="")) > 1800:
        print("提示：查询词编码后超过 1800 字符，搜索引擎可能截断，建议拆分为多次检索",
              file=sys.stderr)

    engine_ids = resolve_engine_ids(args)
    link_urls = {eid: build_url(eid, args.query, args.time) for eid in engine_ids}

    attempted, failures, per_engine = [], [], []
    merged = []
    if args.fetch:
        for i, eid in enumerate(engine_ids):
            if ENGINES.get(eid, {}).get("extract", True) is False:
                failures.append((eid, "该引擎为计算型知识入口，不适用网页结果解析，请直接点击链接"))
                attempted.append((eid, False))
                continue
            results, err = search_one(eid, args.query, args)
            if err:
                failures.append((eid, err))
                attempted.append((eid, False))
            else:
                attempted.append((eid, True))
                per_engine.append((eid, results))
            if i < len(engine_ids) - 1:
                time.sleep(max(args.delay, 1.0))
        merged = merge_results(per_engine)

    if args.json:
        report = json.dumps(render_json(args.query, attempted, failures, merged,
                                        link_urls, args.fetch), ensure_ascii=False, indent=2)
    else:
        report = render_markdown(args.query, engine_ids, attempted, failures, merged,
                                 link_urls, args.fetch)
    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(report)
        except OSError as exc:
            sys.exit(f"无法写入输出文件 {args.output}：{exc}（请检查目录是否存在、是否有写权限）")
        print(f"报告已保存：{args.output}", file=sys.stderr)
    else:
        print(report)
    return 0 if (not args.fetch or not failures or merged) else 1


if __name__ == "__main__":
    sys.exit(main())

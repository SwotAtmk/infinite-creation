# 搜索引擎目录与选型矩阵（16 + 10）

本文件是 multi-search-engine 技能的参考资料。所有 URL 模板与可达性说明基于 2026-10 实测核对，
脚本 `scripts/multi_search.py` 内置同一份注册表。URL 中 `{q}` 代表已做百分号编码的查询词。

## 一、16 个核心搜索引擎

### 国内 7 个（中国大陆可直连）

| id | 引擎 | URL 模板 | 直连抓取 | 适用意图 |
|---|---|---|---|---|
| `bing-cn` | 必应中国 | `https://cn.bing.com/search?q={q}&ensearch=0` | 成功率高，首选 | 综合网页、中文结果、官网定位 |
| `bing-int` | 必应国际（国内入口） | `https://cn.bing.com/search?q={q}&ensearch=1` | 成功率高 | 大陆直出国际/英文结果，Google 替代 |
| `baidu` | 百度 | `https://www.baidu.com/s?wd={q}&rn=10` | 可抓，反爬较强 | 中文资讯、百家号、贴吧、政务民生 |
| `so360` | 360 搜索 | `https://www.so.com/s?q={q}` | 可抓 | 中文资讯、问答、视频内容交叉验证 |
| `sogou` | 搜狗 | `https://www.sogou.com/web?query={q}` | 可抓，偶发验证码 | 微信/知乎/公众号内容收录 |
| `weixin` | 微信搜索 | `https://weixin.sogou.com/weixin?type=2&query={q}` | 反爬强，易验证码 | 微信公众号文章（唯一公开网页入口） |
| `shenma` | 神马搜索 | `https://m.sm.cn/s?q={q}` | 可抓 | 移动端视角的中文长尾内容 |

> 实测备注（脚本抓取模式）：
> - 必应中国结果页结构稳定，链接可直接还原，是抓取模式的首选。
> - 百度/360/搜狗的结果链接是引擎中转链接（`/link?url=…`），点击可正常跳转；
>   360 会在 `data-mdurl` 属性暴露真实地址，脚本已自动还原。
> - 微信搜索连续请求容易出现验证码，单次检索即可，失败就停止，不要反复重试。

### 国际 9 个（需可访问国际互联网的网络环境）

| id | 引擎 | URL 模板 | 抓取友好度 | 适用意图 |
|---|---|---|---|---|
| `duckduckgo` | DuckDuckGo | POST `https://html.duckduckgo.com/html/`（备用 `https://lite.duckduckgo.com/lite/?q={q}`） | 高，无 JS 端点稳定 | 隐私检索、技术资料；约 10 次/分钟限速 |
| `google` | Google | `https://www.google.com/search?q={q}`（抓取用基础版 `&gbv=1`） | 中 | 英文技术资料、官方文档、覆盖面广 |
| `google-hk` | Google 香港 | `https://www.google.com.hk/search?q={q}` | 中 | Google 备用入口，中文权重略高 |
| `ecosia` | Ecosia | `https://www.ecosia.org/search?q={q}` | 高（Bing 索引） | Google 不可用时的国际平替 |
| `yahoo` | Yahoo | `https://search.yahoo.com/search?p={q}` | 中 | 英文/日文资讯、老站收录 |
| `startpage` | Startpage | `https://www.startpage.com/sp/search?query={q}` | 低，常被拦截 | Google 结果源 + 隐私保护，建议浏览器使用 |
| `brave` | Brave | `https://search.brave.com/search?q={q}` | 低，浏览器指纹校验 | 独立索引、技术社区内容 |
| `qwant` | Qwant | `https://www.qwant.com/?q={q}` | 低 | 欧盟隐私引擎 |
| `wolframalpha` | WolframAlpha | `https://www.wolframalpha.com/input?i={q}` | 不适用网页解析 | 数学计算、单位/汇率换算、日期与结构化知识 |

网络可达性会随环境变化。脚本对单引擎失败做隔离处理并在报告中标注原因，
任何情况下都会输出可点击的搜索链接，保证“至少能用”。

#### WolframAlpha 查询示例（链接直达，不做网页结果解析）

| 类型 | 查询词示例 |
|---|---|
| 数学计算 | `integrate x^2 dx`、`solve x^2 - 5x + 6 = 0` |
| 单位/汇率换算 | `100 USD to CNY`、`10 km to miles` |
| 日期与时间 | `days until 2027-01-01`、`2026-10-01 weekday` |
| 理化常数/统计 | `molecular weight caffeine`、`population of Japan` |

脚本抓取模式对该引擎只提供链接（返回结构化知识卡片而非网页列表）；
在 DuckDuckGo 查询词尾加 `!wa` 也可直达，如 `100 USD to CNY !wa`。

## 二、10 个垂直站点（通过 `--vertical` 追加，不计入 16 引擎承诺）

| id | 站点 | URL 模板 | 说明 |
|---|---|---|---|
| `github` | GitHub | `https://github.com/search?q={q}&type=repositories` | 开源仓库；未登录可抓，脚本已适配新页面结构 |
| `stackoverflow` | Stack Overflow | `https://stackoverflow.com/search?q={q}` | 编程问答；直连常 403，建议改用 `site:stackoverflow.com` 走必应 |
| `zhihu` | 知乎 | `https://www.zhihu.com/search?type=content&q={q}` | 反爬强，建议 `site:zhihu.com` 走百度/搜狗 |
| `bilibili` | B 站 | `https://search.bilibili.com/all?keyword={q}` | 视频教程 |
| `toutiao` | 今日头条 | `https://so.toutiao.com/search?keyword={q}` | 资讯/短视频 |
| `juejin` | 掘金 | `https://juejin.cn/search?query={q}` | 前端/中文技术文章 |
| `scholar` | Google 学术 | `https://scholar.google.com/scholar?q={q}` | 论文，需国际网络 |
| `baiduxs` | 百度学术 | `https://xueshu.baidu.com/s?wd={q}` | 中文学术，直连 |
| `weibo` | 微博 | `https://s.weibo.com/weibo?q={q}` | 热点事件/舆情 |

垂直站点反爬策略不一，**通用技巧**：直连抓取失败时，回到综合引擎加 `site:` 限定，
例如在百度搜 `site:zhihu.com 大模型面试`，在必应搜 `site:stackoverflow.com asyncio timeout`，
成功率明显高于直接抓站点内搜索页。

## 三、按检索意图选型

| 意图 | 国内环境推荐 | 国际网络环境推荐 |
|---|---|---|
| 快速验证一个事实/找官网 | `bing-cn` → `baidu` | `google` → `duckduckgo` |
| 英文技术问题/报错排查 | `bing-int` + `stackoverflow`(site: 走必应) | `google` + `duckduckgo` + Stack Overflow |
| 中文热点、新闻、舆情 | `baidu` + `so360` + `sogou`/`weibo` | Google News / `google&tbs=qdr:d` |
| 微信公众号文章 | `weixin` → `sogou` | — |
| 开源代码/库选型 | `bing-int` + `github` | `github` + `google` |
| 学术论文 | `baiduxs` + 知网页外检索 | `scholar` |
| 隐私检索（不留画像） | — | `duckduckgo`/`startpage`/`brave` |
| 数学/汇率/单位/日期 | 直接给 WolframAlpha 链接 | `wolframalpha` |
| 视频教程 | `bilibili`、`so360` | YouTube（可用 DDG `!yt` 快捷跳转） |

## 四、引擎数量怎么选

- **不要默认查全部 16 个**：单次 2–4 个最相关引擎即可，既快又对站点友好。
- 需要“多源交叉验证”（如事实核查、选型对比）时选 3–5 个覆盖不同索引的引擎。
- 全网普查再用 `--all`，脚本会顺序请求并内置 1.5 秒间隔；不要缩短间隔做批量扫取。

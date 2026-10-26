# 搜索操作符、时间过滤与 Bangs 速查

配合 SKILL.md 使用。脚本会自动做 URL 编码；手工拼链接或用网页抓取工具时，
请把空格、中文、`&` 等字符做百分号编码（脚本已处理，无需手工转换）。

## 一、通用高级操作符

| 操作符 | 含义 | 示例 | Google/必应 | 百度/360/搜狗 | DDG |
|---|---|---|---|---|---|
| `"词语"` | 精确匹配词组 | `"大语言模型" 幻觉` | ✅ | ✅ | ✅ |
| `OR` / `|` | 任一关键词 | `langchain OR llamaindex` | ✅ | 百度/360用 `|` | ✅ |
| `-词` | 排除关键词 | `python -snake` | ✅ | ✅ | ✅ |
| `site:域名` | 站内搜索 | `site:github.com transformer` | ✅ | ✅ | ✅ |
| `filetype:后缀` | 指定文件类型 | `年报 filetype:pdf` | ✅（必应同） | 百度/360 ✅ | 用 `f:pdf` |
| `intitle:词` | 标题含关键词 | `intitle:MCP 教程` | ✅ | ✅ | ✅ |
| `inurl:词` | URL 含关键词 | `inurl:docs api` | ✅ | ✅ | 部分支持 |
| `*` | 通配占位 | `"* 即服务" 商业模式` | ✅ | 弱支持 | ✅ |
| `( )` | 关键词分组 | `(LLM OR 大模型) 评测` | ✅ | 不支持 | ✅ |
| `《作品名》` | 作品/书名号精确 | `《人类简史》 书评` | — | ✅ 百度 | — |

实用组合：

```text
site:docs.pytest.org fixture 报错        # 限定官方文档
filetype:pdf 2025 行业研究报告           # 找报告原文
"Connection reset" intitle:解决          # 找排错文章
大模型 评测 -广告 -推广                    # 降低软文干扰
```

操作符都可以组合叠加，多个条件之间用空格连接表示“且”。

## 二、时间范围过滤

| 引擎 | 参数 | 取值 |
|---|---|---|
| Google / Google HK | `&tbs=qdr:X` | `h` 小时 `d` 天 `w` 周 `m` 月 `y` 年 |
| 搜狗 | `&tsn=X` | `1` 一天 `2` 一周 `3` 一月 `4` 一年 |
| DuckDuckGo | 表单字段 `df=X` | `d`/`w`/`m`/`y`（脚本已内置） |
| 百度 | `&gpc=stf%3D<起unix>%2C<止unix>%7Cstftype%3D2` | 自定义起止时间戳，需自行换算 |
| 必应/360 | 无稳定的公开短参数 | 用“关键词 + 年份”缩小范围，或在浏览器里点时间筛选 |

脚本对前三者提供统一参数：`--time h|d|w|m|y`。

```bash
python scripts/multi_search.py "AI 新闻" -e google --time d --fetch
python scripts/multi_search.py "发布会" -e sogou --time w --fetch
```

## 三、DuckDuckGo Bangs（`!` 快捷跳转）

在查询词中以 `!别名` 结尾或开头，DDG 直接跳到对应站点的站内结果，比搜索引擎转一手更快：

| Bang | 目标 | Bang | 目标 |
|---|---|---|---|
| `!g` | Google | `!gh` | GitHub |
| `!so` | Stack Overflow | `!w` | 维基百科 |
| `!yt` | YouTube | `!b` | Bing |
| `!wa` | WolframAlpha | `!map` | 地图 |
| `!r` | Reddit | `!amz` | Amazon |
| `!tw` | X/Twitter | `!gi` | Google 图片 |

示例：`tensorflow cuda 版本对应 !gh` 直达 GitHub 搜索；`100 USD to CNY !wa` 直达计算结果。
完整列表见 duckduckgo.com/bangs（9000+）。

## 四、构造查询词的经验

1. **语言匹配索引**：中文词给国内引擎，英文词给国际引擎；同一主题可双语各搜一轮
   （例：中文「向量数据库选型」+ 英文「vector database comparison 2026」）。
2. **先宽后窄**：首轮只用 2–3 个核心词；结果发散再加 `""`、`site:`、`-排除词` 收敛。
3. **报错信息加引号**：把完整报错片段用 `""` 包起来，命中率显著提高。
4. **空结果改写**：换同义词、换语言、去掉次要词；不要原样反复提交。
5. **垂直站点走 site: 绕行**：知乎/Stack Overflow/微信等站点内搜索反爬强，
   用 `site:域名 关键词` 在必应/百度里搜更稳。

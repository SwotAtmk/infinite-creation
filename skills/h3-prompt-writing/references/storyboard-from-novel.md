# 小说 → storyboard 契约（编译链的上游）

`compile_storyboard.py` 把 **storyboard.json** 编译成 H3 提示词；本文件说明那份 **storyboard.json 怎么来**——把小说/剧本正文变成契约。

> 分工（`doc/consistency-plan.md` §4.11）：**LLM 负责写，脚本负责闸门**。生成器不做校验，只把编译器的 `error` 回灌给 LLM 重写，直到零 error。

> **运行环境说明（本仓库）**：应用内 Agent **没有 shell 工具**，不能执行下面的 `python scripts/...` 命令。这些脚本由**人工/离线**在终端运行；Agent 请直接用领域工具写分镜（`set_storyboard` / `update_shot`），不要尝试执行脚本。

---

## 1. 两条产契约的路径

| 路径 | 适用 | 入口 |
|---|---|---|
| **A · LLM 起草（推荐）** | 有小说/剧本正文，想快速得到可编译的分镜契约 | `scripts/gen_storyboard_llm.py` |
| **B · 手写/迁移** | 精细控制单镜、或把已有 `prompt.txt` 迁成契约 | 直接写 `storyboard.json`（照 `references/storyboard.schema.json`） |

两者产物同一格式，都交给 `compile_storyboard.py` 编译。

---

## 2. 路径 A：`gen_storyboard_llm.py`

只依赖标准库（`urllib`），对接任意 **OpenAI 兼容端点**：本地 `llama.cpp` router（`http://127.0.0.1:1234/v1`）、vLLM、或云端均可。默认读环境变量 `H3_LLM_BASE_URL` / `H3_LLM_MODEL` / `H3_LLM_API_KEY`。

```bash
# 小说 → 契约（本地 LLM），生成后自动跑编译器门禁，error 回灌重写
python scripts/gen_storyboard_llm.py --novel-file novel.md --out storyboard.json

# 带上本地 few-shot 样例（样例已移出仓库，存在 docs/test/ 下）
python scripts/gen_storyboard_llm.py --novel-file ../../docs/test/test-novel.md --out storyboard.json \
    --example-file ../../docs/test/storyboard.example.json --shots-hint 8 --target-total 34

# 契约 → 提示词
python scripts/compile_storyboard.py --storyboard-file storyboard.json --out segments/

# 只看要发给模型的提示词，不发请求（排查/调试）
python scripts/gen_storyboard_llm.py --novel-file novel.md --out storyboard.json --dump-prompt

# 云端端点 / 换模型
python scripts/gen_storyboard_llm.py --novel-file novel.md --out storyboard.json \
    --base-url https://api.example.com/v1 --model some-model --api-key sk-xxx
```

常用开关：

| 开关 | 作用 |
|---|---|
| `--shots-hint N` | 期望镜数（提示，默认 8） |
| `--target-total S` | 目标总时长（秒，提示，默认 32） |
| `--seg-max S` | 单镜时长上限（秒，默认 5.0，防编译器自动拆分） |
| `--art-style "..."` | 强制 `art_style_prefix`（不给则模型按原文定） |
| `--example-file PATH` | few-shot 样式样例（STYLE REFERENCE）。默认取 `references/storyboard.example.json`；该样例已按「测试素材不入库」策略移出版本库，本地跑若要样例请显式指过去：`--example-file ../../docs/test/storyboard.example.json`。**样例影响的是输出深度/风格**（实测：带样例每镜 2 条 beats、无样例 1 条），**不是长度**——单次停机点由模型自身随机早停决定（实测 1k~7k token），与样例无关；无样例也能通过（实测 2 次尝试内闭合） |
| `--attempts N` | 含门禁回灌的最大重试次数（默认 3） |
| `--think` | 打开模型思考（默认关，直出 JSON；Qwen3 系经 `enable_thinking=false`） |
| `--json-mode` | 请求 `response_format=json_object`。**实测对本地 27B 无效**（llama.cpp 该语法允许围栏/散文，不屏蔽提前 EOS），见 §7 |
| `--no-gate` | 不跑编译器门禁闭环（只出草稿） |
| `--keep-raw DIR` | 保存每次尝试的模型原始输出 |

### 生成-门禁闭环

```
小说正文 ──► LLM(系统提示：契约规则 + schema + 已填样例) ──► JSON
                                    ▲                        │
                                    │                   结构自检
                             error 清单回灌               │
                                    │              compile_storyboard.py --json
                                    └──────────────── 门禁（零指代/时长/字段/不重复）
                                                             │
                                                        error=0 → 落盘
```

最多 `--attempts` 次；仍失败则落盘**最优草稿**并返回退出码 1，提示人工修订后重编。

---

## 3. 生成器对模型强制的契约要点

系统提示把 `references/storyboard.schema.json` 与一份**已填样例**一起交给模型，并强制：

1. **只输出一个 JSON 对象**，无围栏、无叙述。
2. **喂 H3 的字段值一律英文**；仅 `title` / `cut_reason` / `continuity_risk` 可中文。
3. **角色**：`name_en` + `static_features`（脸/发/肤/体型）+ `dynamic_features`（服装/鞋/随身物）+ `do_not_change` + `retention_en`；**无资产时不写 `ref_front`**。
4. **场景**：`name_en` + `static_features` + `slugline` + `anchors`（地标及其在画面里的角色）+ `shared_by`；`ref_wide` 置 `null`。
5. **镜头**：
   - `duration` ≤ `--seg-max`（默认 5s，避免编译器自动拆分）；
   - `shot_size_en` / `angle_en` / `camera_move` + `camera_move_en`（非 static 必须写清起点/终点/跟随目标/停止原因）；
   - `world_pos`（相对地标的世界位置）+ `axis_en`（180° 轴线）+ `positions`（`screen_pos`/`facing`/`pose`/`view_target`/`axis_side`）+ `lighting_en`；
   - `beats[].time` 形如 `"0-2s"`，**连续覆盖 `[0, duration]`**（无空洞/重叠）；
   - `beats[].source` 标注来源：`original`（正文事实）/ `added`（创作补充，仅限呼吸·视线·走位等演出细节）/ `tbd`（待确认项）；`added` 不得引入新剧情事件或因果（§8 第 2 条）；
   - `first_frame_hard` / `last_frame_hard`、`overall_soundscape`、`non_diegetic_music`、`shot_purpose`。
6. **零指代**：禁用「上一镜头/继续/同上/照旧/仍然/保持原样/和之前一样」及其英文对应词；跨镜状态一律展开成完整物理描述。
7. **逐段不重复**：任意两镜 `beats[].action` 归一化后不得相同；每镜必须有**不同的可见动作**推进剧情。（身份/站位/光照的跨段重申是设计要求，不算重复。）
8. **剧情保真锁**：只写正文有的事件，不新增/删除/替换/改归属/改顺序；逐拍 `source` 标注（`original`/`added`/`tbd`），`added` 仅限演出细节。生成器另做**角色名是否见于正文**的轻量交叉核对，非正文的名字以 `[保真][warn]` 提示人工确认。
9. **克制、非性化**：不出现裸露、脱衣或性化内容；敏感收尾只作「静默悬念」处理，摄影机留在门外。

---

## 4. 无资产 vs 有资产（段类型自动切换）

契约不要求先有参考图，编译器的**首段类型由首镜 `refs` 决定**：

| 首镜 `refs` | 首段编译为 | 说明 |
|---|---|---|
| `{}`（无资产，纯文字起片） | **T2VA**（三段式，无图对齐指令） | 小说直出即可编译；`--dry-run` 级测试稿 |
| 非空（有参考图） | **Ref2VA**（六段式，带 `<Subject>`/`<Picture>`） | 正式流水线；用参考图锁身份与站位（D11） |

其余段恒为 **FL2VA**（无参考图端口，靠上一段尾帧续接 + 文字重申身份/站位/光照）。

补资产的流程：按 `references/storyboard-contract.md` §7 Phase 2 生成四视图参考板 → 把 `characters.<@标签>.ref_front` 与**首镜** `refs` 填上真实路径 → 重编，首段即由 T2VA 升级为 Ref2VA；后续段不变。

---

## 5. 产物自检清单

- [ ] `python scripts/compile_storyboard.py --storyboard-file storyboard.json --check` → `error=0`
- [ ] 每镜 `duration` ≤ 单段上限；`beats` 连续覆盖 `[0, duration]`
- [ ] 每镜 `positions` / `world_pos` / `axis_en` / `lighting_en` / `first_frame_hard` 齐全
- [ ] 任意两镜 `beats[].action` 不相同（无 `duplicate_action`）
- [ ] 全文无零指代禁用词（无 `banned_phrase`）
- [ ] 剧情只含正文事件（无 AI 自补）

---

## 6. 真实运行记录（Phase 1 端到端验证）

| 项 | 值 |
|---|---|
| 输入 | `docs/test/test-novel.md`（约 2.6k 字，主角/姐姐/门卫/男生，校门 → 走廊 → 教学楼二层）**本地测试素材，不入库（`.gitignore` 忽略 `docs/test/`）** |
| 生成 | `python scripts/gen_storyboard_llm.py --novel-file ../../docs/test/test-novel.md --out storyboard.json --shots-hint 8 --target-total 34 --attempts 3 --keep-raw raw/`（当时 few-shot 样例还在仓库内 `references/storyboard.example.json`，生成器默认读取；该样例现已按「测试素材不入库」移出，复跑须加 `--example-file ../../docs/test/storyboard.example.json`，见 §7） |
| 模型 | 本地 `llama.cpp` router（`http://127.0.0.1:1234/v1`）× `Huihui-Qwen3.8-27B-abliterated-GGUF`，`enable_thinking=false` |
| 结果 | **第 1 次尝试即门禁通过**：8 镜 / 3 场景 / 3 角色（`@主角` `@门卫` `@男生`），原对白以 `<d>[中文] …</d>` 逐字保留，运镜 static/tilt/pan/tracking/push 有变化 |
| 结果备注 | 上表是**当时**（prompt 尚未加 rule 13 `source`、约 9.3k token）的实测。加入 `source` 标注后 prompt 增至约 10k token，实测需 **2–3 次尝试**才闭合（模型在中途随机早停）——**这是「Linter 门禁 + 干净重试」的正常工作形态**，详见 §7.3 |
| 编译 | `python scripts/compile_storyboard.py --storyboard-file storyboard.json --out segments/` → 8 段（1× T2VA + 7× FL2VA），`error=0` |
| 产物 | 已收为 `docs/test/storyboard.example-novel.json`（`--check` → `error=0, warn=0`） |

两点实测经验（已回写进生成器系统提示）：

1. **长输出会被截断**：镜数给到 10 并要求逐镜对白时，本地 27B 会在 JSON 未闭合处停笔（随机，实测 2.7k–7.1k token，见 §7.3）；规则 12「紧凑输出」+ `--shots-hint 8` 后能收得住，但**仍会随机提前停笔**，靠「干净重试」自愈。生成器对「截断」与「语法错」分别回灌不同提示。
2. **运镜可执行性**：`tracking` 常被写成「tracks behind him, following his movement」，缺起点/终点 → 门禁 `camera_not_executable`。规则 9 已要求显式写 `starts … and stops when …`；本条样例中的 2 句在产出后经**分镜审查**按此收紧（其余内容为模型直出）。

---

## 7. 复验记录（few-shot 样例移出仓库后 · 2026-10-12）

**背景**：按「测试素材不入库」，`references/storyboard.example.json` 与 `docs/test/` 一并移出版本库 → 生成器失去默认 few-shot（`load_reference` 找不到文件时静默返回空串）。复验分两次：**A 带本地样例**（`--example-file` 指 `docs/test/`）与 **B 真·出厂状态**（完全不给样例），确认两条路都可用。

### 7.1 复验 A：带本地样例

**命令**（`skills/h3-prompt-writing/` 下执行）：

```bash
python -u scripts/gen_storyboard_llm.py \
    --novel-file ../../docs/test/test-novel.md --out storyboard.json \
    --example-file ../../docs/test/storyboard.example.json \
    --shots-hint 8 --target-total 34 --attempts 3 --keep-raw raw/
```

**结果**：**第 3 次尝试门禁通过**（第 1 次撞生成墙被截断 → 第 2 次产出完整 JSON 但 2 处 `banned_phrase`（`continues from`）→ 第 3 次门禁回灌后修好）。

| 项 | 值 |
|---|---|
| 契约 | 8 镜 / 32s、2 场景（`#校门` `#走廊`）、2 角色（`@主角` `@门卫`）；16/16 beats 带 `source` 标注 |
| 编译 | `compile_storyboard.py --check` → **error=0 / warn=0 / info=5**（5 条 `fidelity_added`，即模型自标的创作补充 beats，符合设计） |
| 出段 | **8 段 = 1× T2VA + 7× FL2VA**（首镜 `refs={}` → T2VA ✓） |
| 对白 | `<d>[Chinese] 你好，请稍等一下。</d>`（通用占位示例）等逐字保留 |

### 7.2 复验 B：真·出厂状态（完全无样例）

命令同上但**去掉 `--example-file`**（`references/` 下无样例 → 静默降级到「无样例」）：

| 项 | 值 |
|---|---|
| 尝试 | **第 2 次尝试门禁通过**（第 1 次停笔截断 → 干净重试即闭合） |
| 契约 | 8 镜 / 32s、2 场景（`#校门` `#走廊`）、3 角色（`@主角` `@门卫` `@男生`）；8/8 beats 带 `source`（**每镜 1 条**，全 `original`） |
| 编译 | `--check` → **error=0 / warn=0 / info=0** |
| 出段 | 8 段 = 1× T2VA + 7× FL2VA ✅ |

**结论：无内置样例也能跑通**（靠「干净重试」自愈），故不依赖 `docs/test/` 素材。

### 7.3 实测结论（A/B 两次对照，均为实测非推测）

1. **本地 27B 会「中途随机提前停笔」**（实测停机点 2.7k–7.1k token，观测上限 ≈7.05k，不是固定墙）：长 JSON 写到一半就吐 EOS，JSON 停在任意字段中间。这与 `--max-tokens`（16384）无关、与服务端长度上限无关——同一模型同一次会话里连续输出 **9000 token 的纯文本毫无问题**（`finish_reason=length`，`truncated=0`、无任何报错）。
2. **截断重试必须换干净上下文**。原实现把整段半截 JSON 作为 `assistant` 消息塞回上下文，实测第 2/3 次**总是更短且仍不闭合**（4984 → 2509 → 1819 token，等于白跑两次）。已改为：截断时**不塞回半截输出**，只回灌「重写一份更紧凑的完整契约」提示 → 第 2 次即产出完整 JSON。
3. **`--json-mode` 对本地 27B 无效**。llama.cpp 的 `response_format=json_object` 允许围栏与散文（实测输出带 ` ```json ` 围栏），不会屏蔽提前 EOS。
4. **`response_format=json_schema`（契约 schema 直接当语法）在本构建不可用**：服务端报 `Failed to initialize samplers: failed to parse grammar`（0.6s 内返回）。原因是 `references/storyboard.schema.json` 含 llama.cpp 转换器不支持的结构（`type: ["string","null"]` / `pattern` / `$ref` 组合）。若日后要强制收尾，需另写严格 GBNF（本机 `llama.cpp-b10448` **不带**任何 `.gbnf`）。
5. **few-shot 的作用是「深度/风格」，不是「长度」**：A（带样例）每镜 **2 条** beats（8 镜 16 条，其中 6 条 `added`）；B（无样例）每镜 **1 条**（8 镜 8 条，全 `original`）。样例让模型写得更细，**不影响能否通过、也不影响总长度**——单次停机点在 **~2.7k–7.1k token 间随机**（A 的 3 次：7.0k 截断 / ~6.7k 闭合 / ~6.8k 通过；B 的 2 次：2.7k 截断 / ~4.7k 闭合），与样例无关。

**给使用者的两点提示**：

- 长契约（≥8 镜）在本地 27B 上属**边缘可用**：完整契约约 18–27KB，单次停机点在 ~2.7k–7.1k token 间随机（无服务端上限、`truncated=0`）。**靠「干净重试」可在 2–3 次尝试内闭合**（A 用 3 次、B 用 2 次）；要更稳可**降目标规模**（`--shots-hint 5`）。`--example-file` 给不给都不影响能否通过，只影响 beats 粒度。
- 本地 27B 只负责「起草 + 门禁闭环」，**最终质量由 `compile_storyboard.py` 的门禁与人审负责**（这正是 §4.11 的分工）。


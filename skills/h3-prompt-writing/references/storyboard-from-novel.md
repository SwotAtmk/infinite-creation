# 小说 → storyboard 契约（编译链的上游）

`compile_storyboard.py` 把 **storyboard.json** 编译成 H3 提示词；本文件说明那份 **storyboard.json 怎么来**——把小说/剧本正文变成契约。

> 分工（`doc/consistency-plan.md` §4.11）：**LLM 负责写，脚本负责闸门**。生成器不做校验，只把编译器的 `error` 回灌给 LLM 重写，直到零 error。

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
| `--attempts N` | 含门禁回灌的最大重试次数（默认 3） |
| `--think` | 打开模型思考（默认关，直出 JSON；Qwen3 系经 `enable_thinking=false`） |
| `--json-mode` | 请求 `response_format=json_object`（语法约束输出） |
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
   - `first_frame_hard` / `last_frame_hard`、`overall_soundscape`、`non_diegetic_music`、`shot_purpose`。
6. **零指代**：禁用「上一镜头/继续/同上/照旧/仍然/保持原样/和之前一样」及其英文对应词；跨镜状态一律展开成完整物理描述。
7. **逐段不重复**：任意两镜 `beats[].action` 归一化后不得相同；每镜必须有**不同的可见动作**推进剧情。（身份/站位/光照的跨段重申是设计要求，不算重复。）
8. **剧情保真锁**：只写正文有的事件，不新增/删除/替换/改归属/改顺序。
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
| 生成 | `python scripts/gen_storyboard_llm.py --novel-file ../docs/test/test-novel.md --out storyboard.json --shots-hint 8 --target-total 34 --attempts 3 --keep-raw raw/` |
| 模型 | 本地 `llama.cpp` router（`http://127.0.0.1:1234/v1`）× `Huihui-Qwen3.8-27B-abliterated-GGUF`，`enable_thinking=false` |
| 结果 | **第 1 次尝试即门禁通过**：8 镜 / 3 场景 / 3 角色（`@主角` `@门卫` `@男生`），原对白以 `<d>[中文] …</d>` 逐字保留，运镜 static/tilt/pan/tracking/push 有变化 |
| 编译 | `python scripts/compile_storyboard.py --storyboard-file storyboard.json --out segments/` → 8 段（1× T2VA + 7× FL2VA），`error=0` |
| 产物 | 已收为 `docs/test/storyboard.example-novel.json`（`--check` → `error=0, warn=0`） |

两点实测经验（已回写进生成器系统提示）：

1. **长输出会被截断**：镜数给到 10 并要求逐镜对白时，本地 27B 会在 JSON 未闭合处停笔（`n_gen≈6.2k`）；规则 12「紧凑输出」+ `--shots-hint 8` 后可稳定收尾。生成器对「截断」与「语法错」分别回灌不同提示。
2. **运镜可执行性**：`tracking` 常被写成「tracks behind him, following his movement」，缺起点/终点 → 门禁 `camera_not_executable`。规则 9 已要求显式写 `starts … and stops when …`；本条样例中的 2 句在产出后经**分镜审查**按此收紧（其余内容为模型直出）。


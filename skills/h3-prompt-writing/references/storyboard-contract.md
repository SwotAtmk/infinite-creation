# Storyboard 契约（多段一致性生成）

把「手写 H3 提示词」升级为「数据契约 → 确定性编译提示词」。`storyboard.json` 是唯一状态源，`scripts/compile_storyboard.py` 是编译内核。**本契约只产出提示词，不提交生成任务**——执行层（ComfyUI / Hub runner、拼帧）由外部负责。

> 背景与设计依据：`doc/consistency-plan.md`（§5.1 模块、§6.0–§6.6 字段与装配映射、§8 门禁）。

---

## 1. 为什么需要契约（要解决的真问题）

H3 一次生成不了长视频（硬件限制），只能**用短视频逐段生成 + 上一段末帧作下一段首帧**拼成长片。这会引入三类典型缺陷：

1. **提示词重复**：直接复制上一段提示词 → 动作被重新播一遍（除非该镜本来就设计成重复动作）。
2. **站位/身份漂移**：FL2VA 段没有参考图端口，模型只能靠文字，若文字不重申身份/站位/光照，画面就会漂。
3. **场景/光照跳变**：段间没有统一的状态账本，靠人记 → 出错。

契约 + 编译器把上述问题变成**确定性校验**：LLM 负责写，脚本负责闸门（§4.11）。

---

## 2. 文件角色

| 文件 | 作用 |
|---|---|
| `references/storyboard.schema.json` | 契约 JSON Schema（字段定义、必填、约束） |
| `docs/test/storyboard.example.json` | 由现有 `prompt.txt` 迁移的 3 段样例（Phase 1 内联参考图路径） |
| `storyboard.json`（用户产物） | 一部片子的分镜契约：角色 / 场景 / 逐镜编排 |
| `continuity-ledger.json`（编译器产出） | 跨镜状态账本：每镜开始/结束状态（§6.5） |
| `segments.json`（编译器产出） | 段清单：段序 / 类型（ref2va·fl2va）/ 时长 / 参考图 / 提示词文件 |
| `scripts/compile_storyboard.py` | 编译内核（六个模块 + 门禁） |

**语言约定**：喂给 H3 的字段值一律用**英文**（H3 只认英文正文），如 `art_style_prefix` / `static_features` / `beats[].action` / `lighting_en` / `camera_move_en`。仅供人读的管理字段（`title` / `cut_reason` / `continuity_risk`）可用中文。

---

## 3. 段类型与拆分规则（硬约束）

- 整片**第一个生成段 = Ref2VA**（带参考图，`refs` 非空）→ 用参考图把身份与站位锁正，其尾帧即后续的标准站位。
- **其余生成段 = FL2VA**（`refs` 留空）。该节点**无参考图端口，只有首帧**，所以身份/站位/光照**必须由文字重申**（`static_features` + `positions` + `lighting_en`）。
- **超长自动拆分**：某 `shot.duration` 超过单段上限（`video.default_max_duration`，默认 5.0s）→ 拆成 N 个子段；**子段沿用同一提示词**（即重复同一动作）。这是硬件限制的产物，编译器会报 `auto_split_repeats_action` 提醒；如非本意，应缩短 `duration` 或把动作拆成多镜。
- **D11 双保险**：正式段**必须有参考图或首帧 + 完整文字**，纯文字只允许作为测试稿。

`Ref2VA` 参考图顺序 = `refs` 键序 → `<Picture 1>`、`<Picture 2>`…；出场角色顺序（`positions` 键序）→ `<Subject 1>`、`<Subject 2>`…；场景随后占一个 `<Subject N>`（如纯白背景 `<Subject 3>`）。

---

## 4. 契约 → H3 段落装配映射（§6.6）

| H3 段落 | Ref2VA（段 0） | FL2VA（段 i>0） | 来源 / 生成规则 |
|---|:---:|:---:|---|
| `subject_definitions` | ✅ | — | `characters`（`<Subject N> is … = name_en + static_features + dynamic_features`）+ `scenes`（背景） |
| `summary` | ✅ | — | `shot.shot_purpose`（写成一句可独立理解的完整句，前置 `[reference generation]`） |
| `retention_analysis` | ✅ | — | 逐 `<Subject N>`：`retention_en`（缺省用 `do_not_change`） |
| `detailed_description` | ✅ | — | `art_style_prefix` + `shot_size_en/angle_en` + 站位段（`positions` + `world_pos` + `axis_en`）+ `lighting_en` + `camera_move_en` + `beats[].action` + 结尾固定句 |
| `integrated_multimodal_description` | — | ✅ | 同 `detailed_description` 内容，但**不带 `<Subject>`/`<Picture>` 标签**（FL2VA 无标签），仍写全物理描述 |
| `overall_soundscape` | ✅ | ✅ | `shot.overall_soundscape`（缺省由 `beats[].sound` 汇总） |
| `non_diegetic_music` | ✅ | ✅ | `shot.non_diegetic_music`（缺省 `N/A`） |
| 保留/规避句 | ✅ | ✅ | 结尾固定：资产不进成片（不复现参考板网格/并排视图）+ 无字幕/logo（可被 `shot.preserve_avoid` 覆盖） |

**装配硬约束**：① Ref2VA 段必须有 `refs` + 完整文字；② FL2VA 段 `refs` 留空但文字必须重申身份/站位/光照；③ 全部展开后过 `PromptLinter` 才可提交。

---

## 5. 提示词规则（编译器强制）

1. **零指代**：最终提示词不得出现「上一镜头 / 继续 / 同上 / 照旧 / 仍然 / 保持原样 / 和之前一样」等上下文依赖词（中英双查）→ `PromptLinter` 报 `banned_phrase`。
2. **世界位置 × 画面位置双写**：每镜同时写「相对地标的世界位置」（`world_pos`）+「轴线」（`axis_en`）+「本次机位下的画面位置与视线」（`positions[].screen_pos/facing/view_target`）；禁止只写「还在原来的位置」。
3. **逐段不重复**（本方案重点）：`beats[].action` 归一化后若与其它镜**完全相同** → 报 `duplicate_action`；确属重复动作镜须显式 `allow_repeat: true`。身份/站位/光照的**跨段重申是设计要求**（D11），不算违规——重复判定只看**动作指纹**。
4. **时长预算**：`beats[].time`（格式 `"起-止s"`）必须**连续覆盖** `[0, duration]`，无空洞、无重叠、不从 0 开始或未到 duration → 报 `duration_*`。
5. **字段完整性**：`positions` / `world_pos` / `axis_en` / `lighting_en` / `first_frame_hard` / 视线 缺一即报错；且 `lighting_en` 必须**真的出现在提示词里**（`lighting_not_in_prompt`）。
6. **运镜可执行性**：`camera_move_en` 必须写清起点/终点/跟随目标/停止原因；非 `static` 运镜若缺起点或终点 → 报 `camera_not_executable`。
7. **镜头语言重复风险（软）**：连续 ≥3 镜「同景别 + 同角度 + 固定机位」→ 报 `shot_language_repeat`（提示，不判错）。

> 任一 `error` → 编译失败（退出码 1），须回契约补全后重编。

---

## 6. 用法

```bash
# 只做门禁校验（CI / 改镜后自检）
python scripts/compile_storyboard.py --storyboard-file storyboard.json --check

# 打印每段 ref_map / 站位 / 提示词，不落盘（人工核对 §6.1）
python scripts/compile_storyboard.py --storyboard-file storyboard.json --dry-run

# 落盘：每段一个 .prompt.txt + segments.json + continuity-ledger.json，交 runner 消费
python scripts/compile_storyboard.py --storyboard-file storyboard.json --out segments/

# 机器可读输出（供脚本化 runner）
python scripts/compile_storyboard.py --storyboard-file storyboard.json --json

# 旧流程兜底：直接读 prompt.txt（按 '###' 分块，只做门禁 + 转发）
python scripts/compile_storyboard.py --prompt-file prompt.txt --check
```

常用开关：`--max-duration`（覆盖单段上限）、`--ref-root`（参考图相对路径根目录，默认取契约文件所在目录）、`--strict-refs`（参考图缺失判错）。

---

## 7. 分阶段

- **Phase 1（当前）**：`refs` 直接内联真实图路径（如 `img/1_女孩.png`），无 manifest；无场景主视图时 `ref_wide: null`，背景走纯文字。
- **Phase 2**：引入 `assets/manifest.json`，`refs` 的 `@标签` 由 manifest 解析为真实路径；补四视图参考板与场景主视图；`--confirm` 阶段门 + 视觉审计（可选项，复用本地视觉 LLM）。

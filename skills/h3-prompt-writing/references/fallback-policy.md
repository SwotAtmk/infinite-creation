# Fallback 降级策略与阶段确认门（2.3，接口契约）

> 本技能只产出**可移植的段产物**（`compile_storyboard.py --out segments/` 的 `*.prompt.txt` + `segments.json`）。
> 实际提交、重试、降级都发生在**外部 runner**（本地 ComfyUI 见 `comfyui-node-adapter.md`，或 H3 Hub 工具）。
> 本文定义 runner 必须遵循的确认门与降级梯子，保证「H3 失败 → 缩片段 → 询问用户」的可复现行为——
> 谁接 runner 都按同一套规则做（doc/consistency-plan.md §2.3、§8 质量门第 1 条）。

## 1. 阶段确认门（`--confirm`）

从 Phase 2 起，任何「会消耗算力/额度」的动作按 资产 → 小样 → 批量 三阶段推进。
每阶段**自动暂停**，列清单等人工 `y` 才继续；`n` 中止并回上一阶段：

| 阶段 | 产出清单必须包含 | 例（第 01 章 8 镜） |
|---|---|---|
| 资产 | 角色/场景视图 + manifest 验收报告（`build_manifest.py --check`） | 3 角色视图 + 3 场景 wide，验收通过 |
| 小样 | 首段（Ref2VA/T2VA）产物 + 实际规格（分辨率/时长/参考图数/单段费用） | 段 0，1 个 mp4，~5s，2 refs |
| 批量 | 全部段清单（`segments.json`）+ 预估总费用 + 本次实际规格 | 8 段 × ~5s，含续接帧策略 |

确认门只做「列清单 + 等待 y/N」，不做任何自动判断；任何阶段被拒，不自动重来，把拒绝原因写下后交回人工。

## 2. H3 生成失败的降级梯子（先减后问）

失败先分类，类别决定能不能自动降级：

| 失败类别 | 判别 | 自动动作 | 询问用户 |
|---|---|---|---|
| 瞬时性 | 超时、限流、网络抖断、节点返回可重试错误 | 原地重试（同参数）≤2 次，退避 3–10s | 否 |
| 长度性 | 连续超时/截断/服务端 413；`segments.json` 里该段 `duration` 偏高 | **缩片段**：把该镜 `duration` 拆小（重编译：调 `--max-duration` 或改契约 `duration`），用更短单位重提 | 缩完后仍失败 → 是 |
| 内容性 | 审核拒绝、明确的内容错误（角色错、场景错、画面文字） | 无。绝不自动改写剧情/换风格/换参考图 | **是** |
| 质量性 | 生成成功但人审不满意 | 无（人审是最终权威） | 是（给出重提参数或人工改契约） |

**铁律**：
- 自动降级只做「重试」和「缩片段」两类，边界是 *不改变剧情内容*（§8 剧情保真锁）；
- 任何「删镜 / 换模型 / 换风格 / 换 Seedance / 改参考图」都必须停下来询问用户；
- 缩片段造成同一动作重放的，由编译器报 `auto_split_repeats_action`（warn），runner 原样转发给人看；
- 询问必须给出「已尝试什么、失败原因、候选动作 2–3 个」，不接受只问一句「怎么办」。

## 3. Seedance 接口（D4：只留接口，不接实现）

Seedance（或其他备选视频模型）只作为**可替换后端**存在，接口形状与 H3 后端完全一致，便于就地切换：

```
submit(segment: {prompt, duration, refs, voice_refs?}) -> job_id
poll(job_id) -> {status: queued|running|done|failed, urls?, error?}
```

切换点由 runner 的配置决定（`backend: h3 | seedance`），**契约与提示词产物不做任何 Seedance 特化**；
货架期未接实现，故不引入任何 Seedance 依赖或调用代码。若未来接入，改造范围仅限 runner 的 submit/poll 两函数。

## 4. runner 的最小接口约定（与本技能对接点）

| 本技能产出 | runner 消费方式 |
|---|---|
| `segments.json`（段序/类型/时长/refs/提示词文件） | 批量提交清单；`--confirm` 阶段门第 3 阶段的清单来源 |
| `*.prompt.txt` | submit 的 `prompt` 正文 |
| `continuity-ledger.json` | 跨镜续接帧的「上一段尾帧」来源（仅运动延续，站位由契约重建） |
| `--json` 编译输出 / 门禁报告 | 提交前必查：任一 `error`（exit 1）禁止提交；`tbd` 待确认项须先人工确认（`--strict-fidelity` 可强制） |
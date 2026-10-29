# 剪辑转场设计与 Seedance 15 秒分段门

> 精编自《灵境AI漫剧制作流 V3.9.0》manju-editing-transition-designer

## 〇、定位与边界

- **目的**：继承导演镜头策略（真一镜到底 / 伪一镜到底 / 常规切镜 / 混合），为每镜锁定时长、进入/退出帧与承接方式；为 Seedance 全能参考把场景拆成不超过 15 秒且自然接力的完整段，优先让导演切镜落在段间。
- **边界**：不为节奏擅删因果、台词、反应或小闭环；不增加或取消导演决定的切镜；不拆散真一镜到底；不用特效转场遮盖生成错误。
- **输入**：锁定剧本、导演切点/禁切区、台词节奏与动作时间线、连续性台账（`continuity-ledger.md`）。

## 一、导演镜头策略（每场唯一，四选一，不得并存）

| 模式 | 判据（互斥，违者返工） |
|---|---|
| `TRUE_ONE_TAKE` 真一镜到底 | 禁切区非空；**不得**含任何切镜指令；必须关闭剪辑切点与隐藏缝；跨段必须保持同一镜头身份、摄影机轨迹、动作、空间、焦点与光线连续；每段恰好 1 个 shot_id 且必填 `continuous_take_unit_id` |
| `SIMULATED_ONE_TAKE` 伪一镜到底 | 禁用可见剪辑切点；**仅**在导演批准的隐藏缝衔接；必须给出 `seam_conditions`；`HIDDEN_SEAM` 必须带 `hidden_seam_id` |
| `CUT_COVERAGE` 常规切镜 | 必须允许剪辑切点且至少含 1 个已批准切点；所有可见切镜引用 `director_cut_directive_id` 并落在许可窗口 |
| `HYBRID` 混合 | 必须允许已批准剪辑切点、至少含 1 个已批准切点，且 `no_cut_zones` 非空 |

每场必须留档：**选择依据 + 被否决方案 + 运镜指令 + 禁切区 + 强制切点/许可窗口 + 生成分段政策**。摄影、分镜、剪辑**不得新增或取消**导演决定；`VISIBLE_CUT` 只在导演许可下出现。段落边界与故事板面板边界**均不得自动解释为剪辑点**。

## 二、转场设计

1. 先按完整场景建立情绪与信息节奏，再落切点；精确切帧只能落在导演的强制切点或许可窗口。
2. 转场方式优先级：**硬切 > 动作匹配 > 视线匹配 > 道具匹配 > 声音桥**（`HARD_CUT / ACTION_MATCH / GAZE_MATCH / PROP_MATCH / SOUND_BRIDGE`）。
   > 🔗 **手法库指针**：段缝层面的**具体技巧手法**（相似动作 / 形状匹配 / 前景遮挡 / 甩镜 / 闪白 / 画中画 + 大师技巧辑录）权威在总控 `short-drama-director/references/creative-transition-library.md`（**D 锁 ④ 技巧型转场** · 2026-10-13 新立）。本节管**剪辑门的判据与优先级**（何时允许切、切在哪个窗口），手法库管**具体怎么接**；两者分工不替代——**需要时手边有的工具箱，不是每段必用**（单集 ≤3 处，为转而转 = 违规）。
3. 叠化、黑白场、甩镜、压缩蒙太奇只在剧本有时间/空间/意识或冲击断裂依据时使用，必须写叙事依据。
4. 不切断台词、动作受力、接收者反应或信息落点。
5. 所有可见切镜须有导演指令依据；禁切区内零切镜（对齐总控 P0 严重跳轴拦截与 qc 门前置）。

## 三、Seedance 15 秒分段门（硬约束）

> ⚠️ **本门分版本执行，禁混写**（对齐总控「2.5/2.0 语法彻底分开」铁律）：
> - **Seedance 2.0 + OMNI_REFERENCE**：**15 秒硬上限**，走本门 §三~§五 全流程（含六级段尾优先级表与随包脚本）。
> - **Seedance 2.5**：段上限 **30 秒**，其分段与出稿走**总控 C1 口径**，**不复用本门 §三 六级段尾优先级表**。
> - 🚫 **工具适用范围（重要）**：§五 的 `validate_seedance_segment_map.py` **硬编码 15 秒**，**只适用于 2.0 分段图**——**禁止**用它校验 2.5 的 30 秒分段图（必然批量 ERROR）。2.5 分段图出稿门禁走总控 `validate_prompt.py <稿> --model 2.5`。

- 每段 `duration <= 15` 秒（**Seedance 2.0 全能参考硬上限**），不以四舍五入、15.01 秒或"生成后再裁掉"规避。
- 先服从导演镜头策略，再优化生成段；模型限制不能创造新切镜。
- 保留锁定台词原文、行动因果、接收者反应和关键声画落点。
- 每段有独立故事任务、完整入口、明确出口和下一段第一动作。

### 分段步骤

1. 把场景展开为连续时间线：剧情节拍、台词及停顿、动作阶段、反应、摄影机运动、声音桥、导演切点和禁切区。
2. 从当前段起点向后扫描 15 秒内全部安全候选。
3. 按以下优先级选择段尾，**不机械取满 15 秒，不机械等长切分**：
   1. 导演批准的可见切镜；
   2. 场景结束或完整镜头结束；
   3. 台词句/语义分句结束，且听者反应已经落地；
   4. 动作结果、道具落点、视线落点或声音桥；
   5. 摄影机停稳、人物稳定姿态或导演批准的隐藏缝；
   6. 仅因模型限制形成的连续续段锚点。
4. 15 秒内已有导演批准切镜时，默认放在段间；只有台词、动作、反应或禁切规则阻止时才能不用，并记录原因。
5. 为相邻段建立入口/出口帧、状态继承与参考接力。

### 禁止段界（段缝检查点）

段缝落在以下位置一律返工：

- 单词、短语或不可分语义中间；
- 台词已说出但接收者反应尚未出现；
- 动作起势与受力结果之间；
- 道具离手但尚未落点；
- 摄影机快速加速、甩动或焦点尚未落稳；
- 导演禁切区内的可见切镜；
- 只为凑到 15 秒而增加的空镜、重复动作或停顿。

### 长台词跨段

优先保留整句。单条台词及必要表演超过可用时长时，只能在剧本已有标点、角色自然换气、明确语义分句或导演批准的反应切点拆分，且必须：

- 保持逐字顺序，不重复、不漏字；
- 标记 `CLAUSE_HEAD / CLAUSE_MIDDLE / CLAUSE_TAIL`；
- 写明 `split_anchor`、前段结束字词和后段起始字词；
- 保持同一 `dialogue_id`、说话者与情绪连续；
- 前后段之间不得插入无来源台词。

找不到安全语义分点时标 `BLOCKED`，返回编剧/导演处理，不擅改台词。

### 参考接力（尾帧用途）

每段为参考素材声明"只继承什么、不得继承什么"。相邻段至少传递：角色身份/造型/表情动作阶段、左右位置/朝向/视线、道具持有者与手位、场景损毁/天气/时间/主光方向/空气状态、镜头身份/焦点/运动阶段。

- 连续镜头：前段**已验收实际尾帧**作为下一段 `EXACT_CONTINUATION`；
- 可见切镜：尾帧只作 `STATE_REFERENCE_ONLY`，并以新镜头首帧规格控制构图。
- 首段：`NOT_APPLICABLE`。

### 段尾类型

| 类型 | 含义 |
|---|---|
| `VISIBLE_CUT` | 正式剪辑切点：段尾停在切前最后稳定帧，下一段从导演批准的新镜头开始（必须带导演切点 ID） |
| `CONTINUOUS_TAKE` | 同一镜头自然续接 |
| `HIDDEN_SEAM` | 只用于导演批准的伪一镜到底接缝（必须带隐藏缝 ID） |
| `GENERATION_ONLY_BOUNDARY` | 只因 15 秒限制续段，**不是成片切镜** |
| `SCENE_END` | 场景结束 |

段缝衔接的投喂侧落地（**段缝画面锁** / 换机位 / 带任务空镜三选一）按总控 D 锁与 `short-drama-director/references/segment-splicing.md` 执行；**段末不写接续尾行**（【接续状态】2026-10-09 废止，C11 反转为残留拦截；C12 规则词混入照常兜底）。

## 四、EDITING_PLAN 模板

结构化分段产物使用以下 JSON 模板（保留原字段结构，裁定：不再强制 V3 公共信封根字段，纯分段校验时保留 `payload` 结构即可；若使用随包脚本校验，脚本要求 `schema_version:"3.0" / artifact_type:"EDITING_PLAN" / stage_id:"16"` 根字段，按脚本要求补齐）：

```json
{
  "scene_id": "",
  "target_profile": {
    "name": "SEEDANCE_2",
    "reference_mode": "OMNI_REFERENCE",
    "max_segment_seconds": 15
  },
  "director_strategy_ref": {
    "strategy_id": "",
    "directive_version": 1,
    "mode": "CUT_COVERAGE"
  },
  "editorial_continuity_mode": "CUT_COVERAGE",
  "rhythm_curve": [],
  "shot_order": [{
    "shot_id": "",
    "duration": 0,
    "in_frame": {},
    "out_frame": {},
    "cut_reason": "",
    "transition": "HARD_CUT",
    "cut_authority": {
      "director_cut_directive_id": null,
      "allowed_window_id": null,
      "mandatory_cut_point_id": null,
      "exact_frame_or_time": "",
      "inside_no_cut_zone": false
    },
    "sound_bridge": ""
  }],
  "segments": [{
    "segment_id": "SEG-0001",
    "duration": 0,
    "shot_ids": [],
    "story_units": [],
    "dialogue_slices": [{
      "dialogue_id": "",
      "speaker_id": "",
      "voice_id": "",
      "exact_text": "",
      "start": 0,
      "end": 0,
      "integrity": "WHOLE",
      "split_anchor": null,
      "continues_to_segment_id": null
    }],
    "visual_action_units": [],
    "boundary_from_previous": "SCENE_ENTRY",
    "boundary_to_next": {
      "type": "VISIBLE_CUT",
      "director_cut_directive_id": "CUT-001",
      "hidden_seam_id": null,
      "reason": "",
      "safety_checks": {
        "dialogue_safe": true,
        "action_safe": true,
        "reaction_safe": true,
        "camera_safe": true
      }
    },
    "boundary_selection": {
      "selected_time": 0,
      "candidate_type": "DIRECTOR_VISIBLE_CUT",
      "why_selected": "",
      "approved_cut_candidates_before_deadline": [],
      "cut_alignment": "ALIGNED_AT_SEGMENT_END",
      "cut_alignment_override_reason": null
    },
    "entry_state": {},
    "exit_state": {},
    "continuity_handoff": {
      "anchor_description": "",
      "must_match": [],
      "previous_approved_tail_ref_required": false,
      "tail_usage": "NOT_APPLICABLE"
    },
    "next_first_action": ""
  }]
}
```

口径说明：

- `boundary_from_previous` 取值：`SCENE_ENTRY / VISIBLE_CUT / CONTINUOUS_TAKE / HIDDEN_SEAM / GENERATION_ONLY_BOUNDARY`；`boundary_to_next.type` 另可取 `SCENE_END`。只有 `VISIBLE_CUT` 是正式剪辑切点。
- `dialogue_slices.integrity` 取值：`WHOLE / CLAUSE_HEAD / CLAUSE_MIDDLE / CLAUSE_TAIL`；非完整台词必须写 `split_anchor`，并以同一 `dialogue_id` 在后段无缝续接。
- 四项 `safety_checks`（dialogue/action/reaction/camera）必须全部为 true。
- `previous_approved_tail_ref_required` 除首段外必须为 true；`tail_usage` 按参考接力规则取值。

## 五、与总控机检的衔接

| 分段门规则 | 对应总控机检项 |
|---|---|
| 段长 ≤ 模型上限（2.0=15s / 2.5=30s） | C1 |
| 切镜上限（镜头数 ≤ ceil(段长/3s)）、单镜 <3s 告警 | C2 |
| 时间轴无断档/重叠、无倒挂 | C3 |
| 段末无接续尾行（残留即 FAIL） | C11（2026-10-09 反转） |
| 镜长按剧情倒推、禁机械等分 | C13（同值镜长占比 ≥70% 告警） |
| 禁拉伸凑时（无台词镜 >5s、纯氛围段 >10s 告警） | C15 |
| 台词语气位与段内落点 | C16 |

## 六、validate_seedance_segment_map.py 用法（本技能 scripts/ 附带）

随包脚本为通用纯 Python 校验器（零第三方依赖，仅校验 EDITING_PLAN JSON 自身结构），已复制到本技能 `scripts/validate_seedance_segment_map.py`。

```bash
python scripts/validate_seedance_segment_map.py "<EDITING_PLAN.json>"
```

- **输入**：按 §三模板填写、且带根字段 `schema_version:"3.0"`、`artifact_type:"EDITING_PLAN"`、`stage_id:"16"` 的 JSON 文件。
- **输出**：全部通过打印 `PASS`；否则逐条打印 `ERROR: ...` 并以退出码 1 结束。**分段锁定前必须 PASS。**
- **校验内容**：根字段齐全；每段 0 < duration ≤ 15；`max_segment_seconds ≤ 15`；`shot_ids/story_units` 非空；相邻段入口类型 = 前段出口类型（首段必须 `SCENE_ENTRY`，末段必须 `SCENE_END`）；`VISIBLE_CUT` 必须带导演切点 ID、非切镜边界禁止携带；`HIDDEN_SEAM` 必须带隐藏缝 ID；四项 safety_checks 全 true；`selected_time = duration`；跳过已批准切镜必须写 `cut_alignment_override_reason`；除首段外尾帧接力必须登记且 `tail_usage` 与入口类型匹配；台词切片落点在段内、非完整切片必须带 `split_anchor`、`CLAUSE_HEAD/MIDDLE` 必须能在目标段找到同一 `dialogue_id/speaker_id/voice_id` 的续接切片。
- **适用范围**：仅当采用结构化 EDITING_PLAN JSON 工作流时使用；七段式文本投喂稿的出稿门禁走总控 `validate_prompt.py`（见 `machine-check-manual.md`），两者不互相替代。

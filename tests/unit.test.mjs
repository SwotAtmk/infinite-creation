import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import {
  analyzeWorkflow, buildWorkflow, getDefaultSpecById, getSpecForKind,
  fallbackVideoPrompt, validateSubShots,
  dialogueSpeakerNames, MAX_SPEAKERS_PER_SHOT, MAX_AUDIO_REFS,
  extractJson, slugify, imageToDataUrl, buildVisionUserMessage, imageUrlParts, buildVisionContentBlocks, llmEndpoint, openaiCompatBaseUrl,
  freeComfy, checkComfyUI, generate, queuePrompt, getHistory, interrupt, deleteQueued, downloadOutput, getObjectInfo, resolveHardwareConfig, HW_PRESETS, loadConfig,
  runFfmpeg,
  toOutputItem, runninghubSubmit, generateTask, uploadTaskInput, downloadTaskOutput, checkBackend, freeBackend, interruptTask, DEFAULT_SPECS,
} from '../lib/core/index.js';
import { ratioToSize, ASSET_CATEGORIES, PROJECT_ASSET_SUBDIRS, filterReferenceImages, splitNovelIntoChapters, FALLBACK_CHAPTER_CHARS, isTruncatedText, classifyAgentMsg, watchdogStep, watchdogStallCheck, AGENT_WATCHDOG, inferVoiceBaseline, HW_PRESETS as SHARED_HW_PRESETS, isPresetWorkflows, presetModeOf, comfyBaseUrl, maskComfyBaseUrl, uploadMediaKind, UPLOAD_MAX_BYTES, SKILL_ZIP_MAX_BYTES, nameMatches, textMentions, isVariantAssetCategory, VARIANT_ASSET_CATEGORIES, isReferenceImageName, REFERENCE_IMAGE_EXTS, REFERENCE_IMAGE_MAX_BYTES } from '../lib/shared/index.js';
import { parseFrontmatter, routeSkill, installSkillsFromZip } from '../lib/agent/index.js';
import { ckBroken, STAGES, STAGE_MAP, preflight } from '../lib/agent/stages.js';
import { RENDER_TOOLS, IMAGE_ASSET_CATEGORIES, runTool, variantReusable, variantPrompt, keepsUserPrompt, TOOL_DEFINITIONS } from '../lib/agent/tools.js';
import { runExclusiveVideo, concurrencyLimit, holdsRenderSlot } from '../lib/agent/job-runner.js';
import { guardToolCall } from '../lib/agent/guard.js';
import { CATEGORIES } from '../app/pages/shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WF = path.join(__dirname, '..', 'workflows');
const BT = String.fromCharCode(96); // 反引号

function load(name) { return JSON.parse(fs.readFileSync(path.join(WF, name), 'utf8')); }

test('analyzeWorkflow: t2i 角色映射（Krea2）', () => {
  const a = analyzeWorkflow(load('krea2_hyperreal_2608.json'));
  assert.equal(a.kind, 't2i');
  assert.deepEqual(a.roles.positive_prompt, { node: '102', field: 'text' });
  assert.equal(a.roles.negative_prompt, undefined);
  assert.deepEqual(a.roles.width, { node: '100', field: 'width' });
  assert.deepEqual(a.roles.height, { node: '100', field: 'height' });
  assert.deepEqual(a.roles.seed, { node: '96', field: 'seed' });
  assert.deepEqual(a.roles.filename_prefix, { node: '95', field: 'filename_prefix' });
});

test('analyzeWorkflow: r2v 角色映射', () => {
  const a = analyzeWorkflow(load('MiniMax_H3_Easy_r2v.json'));
  assert.equal(a.kind, 'r2v');
  assert.deepEqual(a.roles.positive_prompt, { node: '2', field: 'prompt' });
  assert.deepEqual(a.roles.seed, { node: '6', field: 'noise_seed' });
  assert.deepEqual(a.roles.seconds, { node: '2', field: 'seconds' });
});

test('analyzeWorkflow: i2i 识别为 i2i', () => {
  const a = analyzeWorkflow(load('image_qwen_image_edit_2511_i2i.json'));
  assert.equal(a.kind, 'i2i');
  assert.deepEqual(a.roles.positive_prompt, { node: '170:151', field: 'prompt' });
  assert.deepEqual(a.roles.image, { node: '41', field: 'image' });
});

test('buildWorkflow: r2v 媒体绑定', () => {
  const spec = getDefaultSpecById('minimax_h3_r2v');
  const wf = buildWorkflow(spec, {
    positive_prompt: 'P', seconds: 6, aspect_ratio: '16:9', resolution: '480P', seed: 1, filename_prefix: 'video/x',
    references: [
      { type: 'image', filename: 'a.png' },
      { type: 'audio', filename: 'b.flac' },
      { type: 'image', filename: 'c.png' },
    ],
  });
  assert.equal(wf['2'].inputs.prompt, 'P');
  assert.equal(wf['2'].inputs.seconds, 6);
  assert.deepEqual(wf['2'].inputs.media_1, ['15', 0]);
  assert.equal(wf['2'].inputs.media_type_1, 'image');
  assert.deepEqual(wf['2'].inputs.media_2, ['26', 0]);
  assert.equal(wf['2'].inputs.media_type_2, 'audio');
  assert.deepEqual(wf['2'].inputs.media_3, ['32', 0]);
  assert.equal(wf['15'].inputs.image, 'a.png');
  assert.equal(wf['26'].inputs.audio, 'b.flac');
  assert.equal(wf['32'].inputs.image, 'c.png');
  assert.equal(wf['6'].inputs.noise_seed, 1);
});

// 本机 GGUF 工作流：角色值直写被连线占用的输入，并剪掉模板占位资源与 LLM 改写链
function graphIssues(wf, outputClasses) {
  const keep = new Set();
  const stack = Object.keys(wf).filter((id) => outputClasses.includes(wf[id].class_type));
  const roots = [...stack];
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id) || !wf[id]) continue;
    keep.add(id);
    for (const v of Object.values(wf[id].inputs || {})) {
      if (Array.isArray(v) && typeof v[0] === 'string' && wf[v[0]]) stack.push(v[0]);
    }
  }
  const dangling = [];
  for (const node of Object.values(wf)) {
    for (const [f, v] of Object.entries(node.inputs || {})) {
      if (Array.isArray(v) && typeof v[0] === 'string' && !wf[v[0]]) dangling.push(node.class_type + '.' + f);
    }
  }
  return { roots, orphans: Object.keys(wf).filter((id) => !keep.has(id)), dangling };
}

test('GGUF t2i: prompt 直写编码节点并剪掉 LLM 改写链', () => {
  const spec = getDefaultSpecById('qwen_image_2_1_t2i_gguf');
  const wf = buildWorkflow(spec, {
    positive_prompt: 'P', negative_prompt: 'N', width: 1344, height: 768, seed: 5, filename_prefix: 'assets/x',
  });
  assert.equal(wf['459:452'].inputs.prompt, 'P');
  assert.equal(wf['459:452'].inputs.negative_prompt, 'N');
  assert.equal(wf['459:456'].inputs.width, 1344);
  assert.equal(wf['459:458'].inputs.seed, 5);
  assert.equal(wf['461'].inputs.filename_prefix, 'assets/x');
  const g = graphIssues(wf, ['SaveImageAdvanced']);
  assert.deepEqual(g.roots, ['461']);
  assert.deepEqual(g.dangling, []);
  assert.ok(!wf['459:471'], 'TextGenerate 改写链应被剪掉');
});

test('GGUF i2i: 只绑第一张参考图，剪掉模板第二张与对比节点', () => {
  const spec = getDefaultSpecById('qwen_image_2_1_i2i_gguf');
  const wf = buildWorkflow(spec, { positive_prompt: 'P', image: 'ref.png', seed: 2, filename_prefix: 'assets/e' });
  assert.equal(wf['459:474'].inputs.prompt, 'P');
  assert.equal(wf['470'].inputs.image, 'ref.png');
  assert.ok(!wf['475'], '模板自带的第二张参考图应被剪掉');
  const g = graphIssues(wf, ['SaveImageAdvanced']);
  assert.deepEqual(g.dangling, []);
  assert.ok(!g.orphans.length, '不应有孤立节点');
});

test('GGUF r2v: Autogrow 媒体槽按类型各自从 0 编号，标签值翻译成节点枚举', () => {
  const spec = getDefaultSpecById('minimax_h3_r2v_gguf');
  const wf = buildWorkflow(spec, {
    positive_prompt: 'P', seconds: 6, aspect_ratio: '16:9', resolution: '480P', seed: 1, filename_prefix: 'video/x',
    references: [
      { type: 'image', filename: 'a.png' },
      { type: 'audio', filename: 'b.flac' },
      { type: 'image', filename: 'c.png' },
    ],
  });
  const inputs = wf['145'].inputs;
  assert.equal(wf['145'].inputs.prompt, 'P');
  assert.equal(wf['135'].inputs.value, 6, '时长注入 PrimitiveFloat，保留 17k+5 帧对齐表达式');
  assert.equal(wf['115'].inputs.aspect_ratio, '16:9 (Widescreen)');
  assert.equal(wf['115'].inputs.megapixels, 0.5);
  assert.deepEqual(inputs['ref_images.ref_image_0'], ['149', 0]);
  assert.deepEqual(inputs['ref_images.ref_image_1'], ['1002', 0]);
  assert.deepEqual(inputs['ref_audios.ref_audio_0'], ['153', 0]);
  assert.equal(wf['149'].inputs.image, 'a.png');
  assert.equal(wf['153'].inputs.audio, 'b.flac');
  assert.equal(wf['131'].inputs.noise_seed, 1);
  const g = graphIssues(wf, ['SaveVideo']);
  assert.deepEqual(g.dangling, []);
  assert.ok(!g.orphans.length, '未用的视频占位节点应被剪掉');
});

test('GGUF r2v: 未绑定音频时不留悬空的音频槽', () => {
  const spec = getDefaultSpecById('minimax_h3_r2v_gguf');
  const wf = buildWorkflow(spec, { positive_prompt: 'P', references: [{ type: 'image', filename: 'a.png' }] });
  const inputs = wf['145'].inputs;
  assert.ok(!Object.keys(inputs).some((k) => k.startsWith('ref_audios.')), '音频槽应被清空');
  assert.ok(!wf['153'], '未使用的 LoadAudio 占位应被删');
  assert.deepEqual(graphIssues(wf, ['SaveVideo']).dangling, []);
});

test('GGUF tts: 台词/音色描述直写 PrimitiveStringMultiline 并留住模型加载器', () => {
  const spec = getDefaultSpecById('qwen3_tts_voice_design_gguf');
  const wf = buildWorkflow(spec, {
    text: '台词内容', voice_description: '清润少女音', seed: 42, filename_prefix: 'voice/v1',
  });
  assert.equal(wf['74'].inputs.value, '台词内容');
  assert.equal(wf['75'].inputs.value, '清润少女音');
  assert.equal(wf['77'].inputs.seed, 42);
  assert.equal(wf['47'].inputs.filename_prefix, 'voice/v1');
  assert.equal(wf['2'].class_type, 'QwenTTSModelsLoader', '按 repo_id 拉模型的加载器必须保留');
  assert.deepEqual(wf['77'].inputs.qwen_tts_model, ['2', 0]);
  assert.deepEqual(graphIssues(wf, ['SaveAudio']).dangling, []);
});

test('getSpecForKind: config 覆盖规格 id，缺失时抛错', () => {
  assert.equal(getSpecForKind({ workflows: { t2i: 'qwen_image_2_1_t2i_gguf' } }, 't2i').id, 'qwen_image_2_1_t2i_gguf');
  assert.equal(getSpecForKind({}, 'i2i').id, 'qwen_image_edit_2511_i2i');
  assert.equal(getSpecForKind({}, 'r2v').id, 'minimax_h3_r2v');
  assert.throws(() => getSpecForKind({ workflows: { t2i: 'nope' } }, 't2i'), /未找到工作流规格/);
});

test('getSpecForKind: 可按 hardware.mode 选规格（amd → GGUF）', () => {
  assert.equal(getSpecForKind({ hardware: { mode: 'amd' } }, 't2i').id, 'qwen_image_2_1_t2i_gguf');
  assert.equal(getSpecForKind({ hardware: { mode: 'amd' } }, 'i2i').id, 'qwen_image_2_1_i2i_gguf');
  assert.equal(getSpecForKind({ hardware: { mode: 'amd' } }, 'r2v').id, 'minimax_h3_r2v_gguf');
  assert.equal(getSpecForKind({ hardware: { mode: 'amd' } }, 'tts').id, 'qwen3_tts_voice_design_gguf');
  assert.equal(getSpecForKind({ hardware: { mode: 'nvidia' } }, 't2i').id, 'krea2_hyperreal_t2i');
});

test('resolveHardwareConfig: 模式切换工作流预设与显存释放默认值', () => {
  const nv = resolveHardwareConfig({});
  assert.equal(nv.hardware.mode, 'nvidia', '默认英伟达');
  assert.deepEqual(nv.workflows, HW_PRESETS.nvidia);
  assert.equal(nv.generation.freeAfterEvery, 0, 'N 卡默认不做显存释放');
  assert.equal(nv.generation.videoFreeAfterEvery, undefined, '旧键应被迁移掉');

  const amd = resolveHardwareConfig({ hardware: { mode: 'amd' } });
  assert.deepEqual(amd.workflows, HW_PRESETS.amd);
  assert.equal(amd.generation.freeAfterEvery, 3, 'AMD 默认每 3 个生成释放一次');

  // 用户手写的自定义映射不跟随模式，且覆盖模式预设
  const custom = resolveHardwareConfig({ hardware: { mode: 'amd' }, workflows: { t2i: 'my_custom_t2i' } });
  assert.equal(custom.workflows.t2i, 'my_custom_t2i');
  assert.equal(custom.workflows.r2v, HW_PRESETS.amd.r2v);

  // 显式配置优先；旧键 videoFreeAfterEvery 兼容迁移
  assert.equal(resolveHardwareConfig({ generation: { freeAfterEvery: 7 } }).generation.freeAfterEvery, 7);
  assert.equal(resolveHardwareConfig({ generation: { videoFreeAfterEvery: 5 } }).generation.freeAfterEvery, 5);
  assert.equal(resolveHardwareConfig({ hardware: { mode: 'amd' }, generation: { freeAfterEvery: 0 } }).generation.freeAfterEvery, 0);

  // 未知 mode 回退英伟达，不炸
  assert.equal(resolveHardwareConfig({ hardware: { mode: 'weird' } }).hardware.mode, 'nvidia');
});

test('resolveHardwareConfig: generation 被写成非对象时退回默认值（不把 loadConfig 弄崩）', () => {
  // config.json 被手改成 "generation": null / "x" / 5 时，deepMerge 会原样保留该值；
  // 旧代码紧接着往它身上写 freeAfterEvery → TypeError。而 loadConfig 每个请求都要跑，
  // 于是全部路由 500、PUT /api/config 也 500（脏配置只该退回默认值，不该让应用不可用）。
  for (const bad of [null, 'x', 5, [], true]) {
    const r = resolveHardwareConfig({ generation: bad });
    assert.ok(r.generation && typeof r.generation === 'object', 'generation 必须是对象：' + JSON.stringify(bad));
    assert.equal(typeof r.generation.freeAfterEvery, 'number', 'freeAfterEvery 必须是数字：' + JSON.stringify(bad));
    assert.equal(r.generation.videoTimeoutMinutes, 90, '其余字段退回默认值：' + JSON.stringify(bad));
  }
  // 正常的对象配置不受影响（含旧键迁移）
  assert.equal(resolveHardwareConfig({ generation: { videoConcurrency: 3 } }).generation.videoConcurrency, 3);
  assert.equal(resolveHardwareConfig({ generation: { videoFreeAfterEvery: 5 } }).generation.freeAfterEvery, 5);
});

test('resolveHardwareConfig: 其它配置段被写成非对象时同样退回默认值（设置页不再白屏）', () => {
  // PUT /api/config 会把请求体整段写进 config.json：`{comfyui: null}` 这种脏配置被原样保留后，
  // 前端 `cfg.comfyui.provider`（SettingsPage）直接抛 → 设置页整页白屏；llm/server 同理。
  for (const bad of [null, 'x', 5, [], true]) {
    const r = resolveHardwareConfig({ comfyui: bad, llm: bad, server: bad, hardware: bad });
    assert.equal(r.comfyui.provider, 'native', 'comfyui 退回默认（' + JSON.stringify(bad) + '）');
    assert.equal(r.comfyui.baseUrl, 'http://127.0.0.1:8188');
    assert.equal(r.llm.baseUrl, 'https://api.deepseek.com');
    assert.equal(r.llm.model, 'DeepSeek-V4.1-Flash');
    assert.equal(r.server.port, 4600);
    assert.equal(r.hardware.mode, 'nvidia');
  }
  // 正常值不受影响
  const ok = resolveHardwareConfig({ comfyui: { provider: 'runninghub' }, llm: { model: 'm' }, server: { port: 5000 } });
  assert.equal(ok.comfyui.provider, 'runninghub');
  assert.equal(ok.llm.model, 'm');
  assert.equal(ok.server.port, 5000);
});

test('isPresetWorkflows: 仅当映射恰好等于某模式预设时为真（前后端共用同一份常量）', () => {
  assert.equal(isPresetWorkflows(SHARED_HW_PRESETS.nvidia), true);
  assert.equal(isPresetWorkflows(SHARED_HW_PRESETS.amd), true);
  assert.deepEqual(SHARED_HW_PRESETS, HW_PRESETS, 'shared 与 core 转出的预设必须是同一份');
  assert.equal(isPresetWorkflows({ ...SHARED_HW_PRESETS.nvidia, t2i: 'my_custom_t2i' }), false, '手改过 → 不随模式切换');
  assert.equal(isPresetWorkflows({ t2i: 'krea2_hyperreal_t2i' }), false, '缺键 → 不算预设');
  assert.equal(isPresetWorkflows(null), false);
});

test('工作流规格自检: roles/outputs 指向的节点必须在 sourceFile 里真实存在', () => {
  // 防回归：setInput 找不到节点时只打一条 warn 就跳过参数写入（不抛错），
  // 一旦规格与工作流文件对不上，caption/seed 这类参数会被静默丢掉，只留下「用模板占位值生成」的假成功。
  for (const spec of DEFAULT_SPECS) {
    assert.ok(fs.existsSync(path.join(WF, spec.sourceFile)), spec.id + ' 的 sourceFile 不存在: ' + spec.sourceFile);
    const wf = load(spec.sourceFile);
    for (const [role, r] of Object.entries(spec.roles || {})) {
      const node = wf[r.node];
      assert.ok(node, spec.id + ' 的 roles.' + role + ' 指向不存在的节点 ' + r.node);
      assert.ok(Object.prototype.hasOwnProperty.call(node.inputs || {}, r.field), spec.id + ' 的 roles.' + role + ' 指向节点 ' + r.node + ' 上不存在的字段 ' + r.field);
    }
    assert.ok((spec.outputs || []).some((ct) => Object.values(wf).some((n) => n.class_type === ct)), spec.id + ' 的 outputs 在 sourceFile 里一个都匹配不上');
  }
});

test('presetModeOf/isPresetWorkflows: 缺后加的 music 键的老配置仍算预设（AMD 不会被误判成 NVIDIA）', () => {
  // 实测踩坑：music 键加入预设后，老配置（只有 t2i/i2i/r2v/tts）被判为「自定义映射」，
  // 模式推断退化成 nvidia → AMD 专属保护（preflight 的 CK 缺陷与显存余量）静默失效。
  const legacyAmd = { t2i: 'qwen_image_2_1_t2i_gguf', i2i: 'qwen_image_2_1_i2i_gguf', r2v: 'minimax_h3_r2v_gguf', tts: 'qwen3_tts_voice_design_gguf' };
  assert.equal(isPresetWorkflows(legacyAmd), true, '缺 music 键仍应认成 AMD 预设');
  assert.equal(presetModeOf(legacyAmd), 'amd');
  const resolved = resolveHardwareConfig({ workflows: legacyAmd });
  assert.equal(resolved.hardware.mode, 'amd');
  assert.equal(resolved.workflows.music, HW_PRESETS.amd.music, '缺的 music 由预设补齐');
  assert.equal(resolved.generation.freeAfterEvery, 3, 'AMD 默认显存释放次数适用');
  // music 被改成自定义值 → 有自定义键 → 不再当作纯预设（不会随模式切换被覆盖）
  assert.equal(isPresetWorkflows({ ...legacyAmd, music: 'my_music' }), false);
  // 缺的是非后加键 → 依旧不算预设
  assert.equal(isPresetWorkflows({ ...SHARED_HW_PRESETS.nvidia, tts: undefined }), false);
});

test('comfyBaseUrl: native 返回原地址，runninghub 返回固定域名', () => {
  assert.equal(comfyBaseUrl({ comfyui: { provider: 'native', baseUrl: 'http://127.0.0.1:8188' } }), 'http://127.0.0.1:8188');
  assert.equal(comfyBaseUrl({ comfyui: { provider: 'runninghub', apiKey: 'abc123', tier: 'standard' } }), 'https://www.runninghub.cn');
  assert.equal(comfyBaseUrl({ comfyui: { provider: 'runninghub', apiKey: 'abc123', tier: 'plus' } }), 'https://www.runninghub.cn');
  assert.equal(comfyBaseUrl({ comfyui: { provider: 'runninghub', apiKey: '', tier: 'standard' } }), 'https://www.runninghub.cn');
  assert.equal(comfyBaseUrl(null), 'http://127.0.0.1:8188');
});

test('maskComfyBaseUrl: RunningHub 脱敏 apiKey，native 原样返回', () => {
  const key = 'd6198825ebff49b2994bb8c5d7ee3d66';
  assert.equal(maskComfyBaseUrl({ comfyui: { provider: 'runninghub', apiKey: key, tier: 'standard' } }), 'https://www.runninghub.cn（apiKey: d619****3d66）');
  assert.equal(maskComfyBaseUrl({ comfyui: { provider: 'native', baseUrl: 'http://127.0.0.1:8188' } }), 'http://127.0.0.1:8188');
});

test('openaiCompatBaseUrl: 与 llmEndpoint 同一套 /v1 归一化（Agent 运行时不再少一段 /v1）', () => {
  // openclaude 的 OpenAI SDK 只在 base 后拼 '/chat/completions'，不会替你补 /v1：
  // 少了这层归一化，base 写成 http://127.0.0.1:11434 的本地端点会「预检 /v1/models 通过、
  // llmChat /v1/chat/completions 通过，唯独整条 Agent 流水线请求 /chat/completions 404」。
  assert.equal(openaiCompatBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1');
  assert.equal(openaiCompatBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(openaiCompatBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1');
  assert.equal(openaiCompatBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
  // 已经写到 /chat/completions 的地址回退成 base
  assert.equal(openaiCompatBaseUrl('http://127.0.0.1:8080/v1/chat/completions'), 'http://127.0.0.1:8080/v1');
  // 与 llmEndpoint 同源：base + '/chat/completions' 必须与直连调用完全一致
  for (const u of ['http://127.0.0.1:11434', 'http://127.0.0.1:8080/v1', 'https://api.deepseek.com']) {
    assert.equal(openaiCompatBaseUrl(u) + '/chat/completions', llmEndpoint(u));
    assert.equal(llmEndpoint(openaiCompatBaseUrl(u)), llmEndpoint(u));
  }
});

test('openclaude providerEnv 的 OPENAI_BASE_URL 走归一化（不是裸 baseUrl）', () => {
  // providerEnv 不导出（整份文件会拉起 vendor SDK），改用源码守卫钉住这一行：
  // 一旦有人改回 `cfg.llm?.baseUrl`，就是「预检通过、流水线 404」那个 bug 复发。
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent', 'openclaude-agent.js'), 'utf8');
  assert.match(src, /OPENAI_BASE_URL:\s*openaiCompatBaseUrl\(/, 'OPENAI_BASE_URL 必须经 openaiCompatBaseUrl 归一化');
});

test('concurrencyLimit: runninghub 用 runninghubConcurrency，native 用 videoConcurrency', () => {
  assert.equal(concurrencyLimit({ comfyui: { provider: 'runninghub' }, generation: { runninghubConcurrency: 5 } }), 5);
  assert.equal(concurrencyLimit({ comfyui: { provider: 'runninghub' }, generation: {} }), 1);
  assert.equal(concurrencyLimit({ comfyui: { provider: 'native' }, generation: { videoConcurrency: 2 } }), 2);
  assert.equal(concurrencyLimit({ generation: { videoConcurrency: 1 } }), 1);
});

test('toOutputItem: fileType → kind 映射，filename 取 fileUrl 末段', () => {
  assert.equal(toOutputItem({ fileUrl: 'https://x.y/a.png', fileType: 'png' }).kind, 'images');
  assert.equal(toOutputItem({ fileUrl: 'https://x.y/b.mp4', fileType: 'mp4' }).kind, 'videos');
  assert.equal(toOutputItem({ fileUrl: 'https://x.y/c.wav', fileType: 'wav' }).kind, 'audio');
  assert.equal(toOutputItem({ fileUrl: 'https://x.y/sub/d.png', fileType: 'png' }).filename, 'd.png');
  assert.equal(toOutputItem({ fileUrl: 'https://x.y/d.png', fileType: 'png' }).fileUrl, 'https://x.y/d.png');
});

test('runninghubSubmit: 提交体含 workflowId=1 + workflow JSON 串 + apiKey', async () => {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ code: 0, msg: 'success', data: { taskId: 't1', taskStatus: 'QUEUED' } }) };
  };
  try {
    const cfg = { comfyui: { provider: 'runninghub', apiKey: 'key123', tier: 'standard' } };
    const { taskId } = await runninghubSubmit(cfg, '{"1":{}}', 'cid1');
    assert.equal(taskId, 't1');
    const body = calls[0].body;
    assert.equal(body.workflowId, 1);
    assert.equal(body.workflow, '{"1":{}}');
    assert.equal(body.apiKey, 'key123');
    assert.equal(body.randomSeed, true);
    assert.equal(body.clientId, 'cid1');
    assert.ok(!('instanceType' in body), 'standard 不应传 instanceType');
  } finally {
    global.fetch = orig;
  }
});

test('RunningHub baseUrl 下所有 ComfyUI 接口都保留 /proxy/<key> 前缀（修复 /view 401）', async () => {
  const base = 'https://www.runninghub.cn/proxy/mykey';
  const urls = [];
  const orig = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  };
  try {
    await checkComfyUI(base);
    await getObjectInfo(base);
    await queuePrompt(base, { '1': { class_type: 'X', inputs: {} } }, 'cid');
    await getHistory(base, 'p1');
    await interrupt(base);
    await freeComfy(base);
    await downloadOutput(base, { filename: 'a.png', subfolder: '', type: 'output' });
  } finally {
    global.fetch = orig;
  }
  assert.ok(urls.length >= 7, '应至少发起 7 个接口请求，实际 ' + urls.length);
  for (const u of urls) {
    assert.ok(u.startsWith(base + '/'), '接口 URL 应保留 apiKey 前缀，实际：' + u);
  }
});

test('getSpecForKind: runninghub 固定使用配套 API 工作流（忽略 hardware.mode）', () => {
  const cfg = { comfyui: { provider: 'runninghub' }, hardware: { mode: 'amd' } };
  assert.equal(getSpecForKind(cfg, 't2i').id, 'runninghub_krea2_t2i');
  assert.equal(getSpecForKind(cfg, 'i2i').id, 'runninghub_qwen_image_edit_2511_i2i');
  assert.equal(getSpecForKind(cfg, 'r2v').id, 'runninghub_minimax_h3_r2v');
  assert.equal(getSpecForKind(cfg, 'tts').id, 'runninghub_qwen3_tts_voice_design');
});

test('buildWorkflow: RunningHub 工作流（子目录 + 带空格文件名）可加载并正确映射', () => {
  const t2i = buildWorkflow(getDefaultSpecById('runninghub_krea2_t2i'), { positive_prompt: '测试提示词', width: 1024, height: 1024, seed: 1 });
  assert.equal(t2i['102'].inputs.text, '测试提示词');
  assert.equal(t2i['100'].inputs.width, 1024);
  assert.equal(t2i['96'].inputs.seed, 1);
  const i2i = buildWorkflow(getDefaultSpecById('runninghub_qwen_image_edit_2511_i2i'), { positive_prompt: '编辑', image: 'ref.png', seed: 2 });
  assert.equal(i2i['218'].inputs.prompt, '编辑');
  assert.equal(i2i['41'].inputs.image, 'ref.png');
  const tts = buildWorkflow(getDefaultSpecById('runninghub_qwen3_tts_voice_design'), { text: '台词', voice_description: '少女音' });
  assert.equal(tts['74'].inputs.value, '台词');
  assert.equal(tts['75'].inputs.value, '少女音');
});

test('preflight: 不拦「同批/vision」这类服务状态判定，只做就绪检查（服务没起就报错退出）', async () => {
  const local = { llm: { baseUrl: 'http://127.0.0.1:1', vision: false }, comfyui: { baseUrl: 'http://127.0.0.1:1' } };
  // 同批勾「LLM 创作 + 资产图」不再被拦（应用不根据服务能否同时常驻替用户决定）→ 走到就绪检查才失败
  await assert.rejects(() => preflight(['llm', 'image'], { ...local, hardware: { mode: 'amd' } }), /LLM 未就绪/);
  // vision 开着也不再拦渲染阶段 → 同样只报 ComfyUI 未就绪
  await assert.rejects(() => preflight(['image'], { ...local, hardware: { mode: 'amd' }, llm: { baseUrl: 'http://127.0.0.1:1', vision: true } }), /ComfyUI 未就绪/);
  await assert.rejects(() => preflight(['llm', 'image'], { ...local, hardware: { mode: 'nvidia' } }), /LLM 未就绪/);
  // 未选阶段仍然拦
  await assert.rejects(() => preflight([], local), /未选择任何阶段/);
});

test('fallbackVideoPrompt: 占位符与一致性描述', () => {
  const p = fallbackVideoPrompt({
    references: [{ label: '小明（人物形象）' }, { label: '小明的声音' }],
    style: '国漫', characterDesc: '黑发少年', sceneDesc: '教室', subShots: '0-3秒：……',
  });
  assert.ok(p.includes('__MINIMAX_H3_REF_1__小明（人物形象）'));
  assert.ok(p.includes('__MINIMAX_H3_REF_2__小明的声音'));
  assert.ok(p.includes('角色保持一致：黑发少年'));
  assert.ok(p.includes('画面风格：国漫'));
});

test('validateSubShots: 超出时长检测', () => {
  assert.equal(validateSubShots(5, '0-8秒：……'), '子分镜提示词的时间（8 秒）超过了总时长（5 秒）');
  assert.equal(validateSubShots(10, '0-5秒：……5-9秒：……'), null);
});

test('dialogueSpeakerNames: 解析说话人 + 约束常量', () => {
  assert.deepEqual(dialogueSpeakerNames(''), []);
  assert.deepEqual(dialogueSpeakerNames('何洛南：喂？\n杜凡：哥！你在哪个桌？'), ['何洛南', '杜凡']);
  // 带舞台提示括号与句尾标点
  assert.deepEqual(dialogueSpeakerNames('林默（站在路口，望着远处）：我知道你一直在这里。\n阿九（从阴影中走出，声音低沉）：你终于来了。'), ['林默', '阿九']);
  // 同一说话人多行去重
  assert.deepEqual(dialogueSpeakerNames('何洛南：喂？\n何洛南：左边靠窗最后一桌。'), ['何洛南']);
  // 无冒号描述行跳过
  assert.deepEqual(dialogueSpeakerNames('街道上行人稀少，橙红夕阳把影子拉得很长。'), []);
  // 半角冒号 + 台词内冒号不误切
  assert.deepEqual(dialogueSpeakerNames('小明:现在是3:30了'), ['小明']);
  assert.equal(MAX_SPEAKERS_PER_SHOT, 2);
  assert.equal(MAX_AUDIO_REFS, 3);
});

test('参考图白名单：前端选择器与后端校验共用一份（含无 MIME 的合法 png）', () => {
  assert.equal(isReferenceImageName('a.png'), true);
  assert.equal(isReferenceImageName('b.JPG'), true);
  assert.equal(isReferenceImageName('c.jpeg'), true);
  assert.equal(isReferenceImageName('d.webp'), true);
  assert.equal(isReferenceImageName('e.gif'), true);
  // 后端只认这五种：前端不该再把它们放进去（选中→上传→400）
  assert.equal(isReferenceImageName('f.bmp'), false);
  assert.equal(isReferenceImageName('g.avif'), false);
  assert.equal(isReferenceImageName('h.svg'), false);
  assert.equal(isReferenceImageName('没有扩展名'), false);
  assert.equal(isReferenceImageName(''), false);
  assert.equal(isReferenceImageName(null), false);
  assert.equal(isReferenceImageName('.png'), false);           // 只有扩展名不是图片（后端 extname → '' → 400）
  assert.equal(isReferenceImageName('资料.png'), true);
  assert.equal(isReferenceImageName('a.b.png'), true);
  assert.equal(REFERENCE_IMAGE_MAX_BYTES, 10 * 1024 * 1024);
  const route = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'projects', '[id]', 'references', 'route.js'), 'utf8');
  assert.ok(/REFERENCE_IMAGE_EXTS/.test(route) && /REFERENCE_IMAGE_MAX_BYTES/.test(route), '路由必须用共享白名单/上限');
  assert.ok(!/const IMAGE_EXTS = new Set\(\['/.test(route), '路由不该再自带一份扩展名白名单');
  const picker = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ReferencePicker.jsx'), 'utf8');
  assert.ok(/isReferenceImageName\(file\.name\)/.test(picker), '选择器必须与后端同口径判定');
  assert.ok(!/file\.type\.startsWith\('image\/'\)/.test(picker), '选择器不该再按 MIME 前缀过滤（无 type 的合法 png 会被静默丢掉）');
});

test('技能扫描：目录已删除的技能行必须被清掉（scanSkills 不只会 upsert）', () => {
  const se = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent', 'skill-engine.js'), 'utf8');
  // 实机核验见探针 ic-r9-skills-probe.mjs（上传技能 → 删目录 → 重扫；修复前列里仍有该技能）
  assert.ok(/Skills\.remove\(s\.id\)/.test(se), '目录已删除的陈旧技能行要被清掉，否则界面列着一条加载不出内容的技能');
  assert.ok(/seen\.has\(s\.id\)/.test(se), '只清理本次扫描没见到的行');
  assert.ok(/rel\.startsWith\('skills\/'\)/.test(se), '只清理 path 指向 skills/ 的行（不碰非扫描来源）');
});

test('设置页：配置拉取失败不能永久停在「配置加载中…」（源码守卫）', () => {
  const sp = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'SettingsPage.jsx'), 'utf8');
  // 原先只 catch 弹一次 toast：cfg 一直是 null → 页面永远停在加载态、也没有「返回」按钮，
  // 用户既看不到原因也退不出去（只能刷浏览器）。
  assert.ok(/setLoadErr\(e\.message/.test(sp), '拉取配置失败要把原因记下来');
  assert.ok(/配置加载失败：\{loadErr\}/.test(sp), '失败态要把原因显示出来');
  assert.ok(/onPress=\{loadConfig\}>重试/.test(sp), '失败态要有「重试」');
  assert.ok(/onPress=\{onBack\}>返回/.test(sp), '失败态要有「返回」出口');
});

test('运行日志：完整日志按「目标任务 id」取，不随 jobs 数组引用反复重取（源码守卫）', () => {
  const ct = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ConsoleTab.jsx'), 'utf8');
  // jobs 每次 loadProject 都是新数组（运行中 2.5s 一次 + 每条 WS 消息），当依赖会让
  // 完整日志（后端 readFileSync 整个文件）被反复重取；依赖换成目标任务 id + 固定低频轮询。
  assert.ok(/\[projectId, logJobId, logLive, logTick\]/.test(ct), '依赖必须是目标任务 id，而不是整个 jobs 数组');
  assert.ok(!/\}, \[projectId, jobs\]\)/.test(ct), '不该再把 jobs 数组当完整日志的依赖');
  assert.ok(/logSeqRef\.current/.test(ct), '需要 seq 丢弃过期响应（换任务时旧响应可能后到并覆盖新内容）');
  assert.ok(/if \(!logLive\) return undefined;/.test(ct), '任务已结束就不必再轮询日志文件');
  assert.ok(/setLogTick\(\(t\) => t \+ 1\); onRefresh\(\)/.test(ct), '「刷新」按钮要能立刻重取完整日志');
});

test('分镜素材选择器：变体只列、只绑本镜角色的服装/年龄（源码守卫）', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ShotMaterialPicker.jsx'), 'utf8');
  // 变体只在「所属角色也在本镜」时才生效（refs.js 按 parent_id 替换该角色的参考图），
  // 原先本镜没有角色时把「所属角色」回退成全部角色 → 能建/选到本镜根本用不上的变体。
  assert.ok(/const parentChoices = shotChars;/.test(p), '「所属角色」只能是本镜已绑定的角色');
  assert.ok(!/shotChars\.length \? shotChars : characters/.test(p), '不该再回退到「全部角色」');
  assert.ok(/if \(isVariant\) return shotCharIds\.has\(a\.parent_id\)/.test(p), '已有变体列表只列本镜角色的变体');
  assert.ok(/isVariant && !parentChoices\.length/.test(p), '本镜没有角色时要提示先绑角色（并禁用上传）');
});

test('参考图上传/编辑不能建变体：服装/年龄必须挂在角色下（源码守卫）', () => {
  const post = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'projects', '[id]', 'references', 'route.js'), 'utf8');
  // 实机核验见探针 ic-r8-parent-probe.mjs 的 K 段（导入素材库+服装 → 400 而非 500；道具 → 200）
  assert.ok(/mode === 'library' && isVariantAssetCategory\(assetCategory\)/.test(post), '素材库模式必须拦下变体分类，否则 db 守卫抛错 → 500 且文件已落盘');
  assert.ok(!/PROJECT_ASSET_SUBDIRS\[info\.category\] \? info\.category/.test(post), '视觉模型若返回变体分类要退回 other，不能让上传整体失败');
  const patch = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'projects', '[id]', 'references', '[rid]', 'route.js'), 'utf8');
  assert.ok(/body\.category !== undefined && isVariantAssetCategory\(category\)/.test(patch), 'PATCH 显式把分类改成变体必须 400');
  assert.ok(/BAD_VARIANT_PARENT/.test(patch), 'db 守卫的领域错误码必须翻成 400，不能漏成 500');
  assert.ok(/assetNow\.category === category \|\| isVariantAssetCategory\(category\)\) \? \{ description \}/.test(patch), '分类没变（或是变体分类）时不要把 category 传给 Assets.update，否则存量无父变体连改描述都被拒');
  const picker = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ReferencePicker.jsx'), 'utf8');
  assert.ok(/isVariantAssetCategory/.test(picker) && /libCategoryOptions/.test(picker), '前端不该给出「导入素材库 + 服装/年龄」这个必然被拒的选项');
});

test('server /files：Range 的后缀范围 bytes=-N 返回末尾 N 字节（源码守卫）', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // 实机核验见探针 ic-range-probe.mjs（修复前 bytes=-100 → "bytes 0-100/…" 即开头 101 字节；修复后 → 末尾 100 字节）
  assert.ok(/if \(!m\[1\]\) \{/.test(s), 'bytes=-N（无起始值）必须单独走后缀分支');
  assert.ok(/start = Math\.max\(total - n, 0\)/.test(s), '后缀范围的起点应为 total-n（最后 N 字节）');
  assert.ok(/n <= 0\) \{ reject\(\)/.test(s), 'bytes=-0 非法，应按 RFC 回 416');
});

test('server：/ws 的客户端畸形帧不能让整个进程退出（源码守卫）', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/ws\.on\('error'/.test(s), "ws 必须挂 'error' 监听：畸形帧会让 ws emit('error')，无人接管时抛 uncaughtException、进程直接退出");
  assert.ok(/socket\.on\('error'/.test(s), "升级握手中途断开的 raw socket 'error' 也要兜住（ECONNRESET）");
});

test('界面小修：分镜空态按筛选结果、章节游标记 id、参考图上传按条摘除（源码守卫）', () => {
  const shots = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ShotsTab.jsx'), 'utf8');
  assert.ok(/!shown\.length && <p/.test(shots), '分镜空态必须按筛选后的 shown 判断');
  assert.ok(!/!shots\.length &&/.test(shots), '不该再用未筛选的 shots.length 判空态（按章筛选时会永远不提示）');
  const pv = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ProjectView.jsx'), 'utf8');
  assert.ok(/const \[cursorId, setCursorId\]/.test(pv), '章节游标必须记 id');
  assert.ok(!/setCursor\(/.test(pv), '不能再存章节下标（排序/删除后会指向别的章节）');
  assert.ok(/setCursorId\(\(x\) => \(c\.some\(\(ch\) => ch\.id === x\)/.test(pv), '章节列表变化后要按 id 保持选中、否则退回第一章');
  assert.ok(/<SelectItem key=\{c\.id\}>/.test(pv), '章节下拉的 key 应该是章节 id');
  const cv = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ChaptersView.jsx'), 'utf8');
  assert.ok(/setRefs\(\(prev\) => prev\.filter\(\(x\) => x\.key !== it\.key\)\)/.test(cv), '上传成功的参考图要立刻从待上传列表摘掉（否则重试会重复上传）');
});

test('背景音乐：只提交任务就不能宣称「已合成」；全部章节失败要让任务失败（源码守卫）', () => {
  const mt = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'MusicTab.jsx'), 'utf8');
  assert.ok(!/已应用背景音乐并重新合成成片/.test(mt), 'apply 只是提交后台任务，不能宣称已经重新合成完成');
  assert.ok(/已提交背景音乐应用/.test(mt), 'apply 的成功提示必须说明「已提交」并把进度指向运行日志');
  assert.ok(!/setDetailAsset/.test(mt), '详情弹窗不能存整个对象快照（轮询/生成写回的新状态反映不到弹窗）');
  assert.ok(/const detailAsset = detailId \? assets\.find/.test(mt), '详情内容必须按 id 从最新 assets 派生');
  const tools = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent', 'tools.js'), 'utf8');
  assert.ok(/results\.every\(\(r\) => r\.error\)/.test(tools), '全部章节失败时必须报失败，不能静默记 done');
});

test('isVariantAssetCategory: 只有服装/年龄算「挂在角色下的变体」', () => {
  assert.equal(isVariantAssetCategory('costume'), true);
  assert.equal(isVariantAssetCategory('age'), true);
  assert.deepEqual(VARIANT_ASSET_CATEGORIES, ['costume', 'age']);
  // 其他分类都不是变体（不该被要求 parent_id）
  for (const c of ['character', 'scene', 'prop', 'voice', 'music', 'sfx', 'video', 'other']) {
    assert.equal(isVariantAssetCategory(c), false, c + ' 不应被当成变体');
    assert.ok(VARIANT_ASSET_CATEGORIES.includes(c) === false);
  }
});

test('assets POST：服装/年龄变体强制 parent_id 且必须指向角色（源码守卫）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'projects', '[id]', 'assets', 'route.js'), 'utf8');
  assert.ok(/isVariantAssetCategory\(category\)/.test(src), '写入端必须按分类判定变体');
  assert.ok(/parent\.category !== 'character'/.test(src), 'parent_id 必须校验指向角色素材');
  assert.ok(/parent_id: parentId/.test(src), 'parent_id 必须真的落库（原来被丢弃）');
  // 非变体分类带 parent_id 必须被拒（旧行为：只要父存在就放行 → 被当子变体级联删）
  assert.ok(/parent_id 只用于服装/.test(src), '非变体分类不得接受 parent_id');
  assert.ok(/BAD_ASSET_PARENT/.test(src), 'db 层的非变体父守卫要翻成 400');
});

test('工具 schema：create_asset / generate_asset_from_reference 暴露 parent_id（否则变体写入只能撞 DB 错误）', () => {
  const props = (n) => TOOL_DEFINITIONS.find((t) => t.function.name === n).function.parameters.properties;
  // 之前 schema 的 category 枚举含 costume/age，却没有 parent_id → 模型没法把变体绑到角色，
  // 只能写出无父变体（被 db 层 BAD_VARIANT_PARENT 拒绝，且是模型看不懂的 DB 错误、无法补救）
  assert.ok(props('create_asset').parent_id, 'create_asset 必须声明 parent_id');
  assert.ok(props('generate_asset_from_reference').parent_id, 'generate_asset_from_reference 必须声明 parent_id');
});

test('项目路由：自定义宽高区间（BAD_PROJECT_DIM）必须翻 400，不能漏成 500', () => {
  // 区间校验在 db 层（UI/内置 Agent/外部 harness 三条写入路径共用一份）；
  // 两条项目路由若不认 BAD_PROJECT_DIM，就会把「入参错误」报成 500，用户拿不到可读原因。
  for (const segs of [['app', 'api', 'projects', 'route.js'], ['app', 'api', 'projects', '[id]', 'route.js']]) {
    const src = fs.readFileSync(path.join(__dirname, '..', ...segs), 'utf8');
    assert.ok(/e\.code === 'BAD_PROJECT_DIM'/.test(src), segs.join('/') + ' 必须把 BAD_PROJECT_DIM 翻成 400');
  }
});

test('项目删除：先给本项目活动任务打停止标记再删（否则任务继续跑、把孤儿行写回已删项目）', () => {
  // 任务行会随 Projects.remove 一起删掉，而进程里那条任务不会停（停止注册表按 jobId 在内存里）：
  // 它会继续出图/出片，把 chapters/shots/assets 重新插回一个「已不存在的项目」——界面看不到也停不掉。
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'projects', '[id]', 'route.js'), 'utf8');
  const stop = src.indexOf('stopJob(j.id)');
  const remove = src.indexOf('Projects.remove(id)');
  assert.ok(stop > 0, '删除项目必须先停本项目活动任务');
  assert.ok(/status === 'running' \|\| j\.status === 'queued'/.test(src), 'running 与 queued 都算活动任务');
  assert.ok(/interruptTask\(loadConfig\(\)\)/.test(src), '执行中的任务要主动打断 ComfyUI（与 /stop、/cancel 同一口径）');
  assert.ok(remove > stop, '停止必须发生在删除之前');
  assert.ok(/stopped: active\.map/.test(src), '接口要回报实际停了哪几条任务');
});

test('nameMatches: 规范化后精确相等（短名不被同场更长角色名误命中）', () => {
  assert.equal(nameMatches('小明', '小明'), true);
  // canonical 名带身份后缀 / 舞台提示：对白说话人是「小明」，角色资产名是「小明（少年）」
  assert.equal(nameMatches('小明', '小明（少年）'), true);
  assert.equal(nameMatches('小明（少年）', '小明'), true);
  assert.equal(nameMatches('林默（站在路口）', '林默'), true);
  // 互为子串的名字必须判为不同人：「明」不因对白里「小明」说话而被当成说话人
  assert.equal(nameMatches('小明', '明'), false);
  assert.equal(nameMatches('明', '小明'), false);
  assert.equal(nameMatches('李', '小李'), false);
  // 空值不匹配（避免「匿名角色」互相匹配上）
  assert.equal(nameMatches('', '小明'), false);
  assert.equal(nameMatches('小明', ''), false);
  assert.equal(nameMatches(null, undefined), false);
});

test('短名串扰：音色归属与分镜面板都走 nameMatches（源码守卫）', () => {
  // refs.js 的 speaks / ShotsTab 的说话角色展示都不导出（前者要 DB，后者是 JSX），用源码守卫钉住
  const refs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'refs.js'), 'utf8');
  assert.ok(/nameMatches\(s, c\.name\)/.test(refs), 'refs.js 的说话人判定必须用 nameMatches');
  assert.ok(!/includes\(c\.name\)/.test(refs), 'refs.js 不应再用 includes 双向包含匹配');
  const shots = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ShotsTab.jsx'), 'utf8');
  assert.ok(/nameMatches\(sp, c\.name\)/.test(shots), 'ShotsTab 的说话角色判定必须与后端同口径');
  assert.ok(!/includes\(c\.name\)/.test(shots), 'ShotsTab 不应再用 includes 双向包含匹配');
});

test('textMentions: 短名不被同场更长角色名吞掉（换装/年龄变体归属）', () => {
  const names = ['小明', '明'];
  assert.equal(textMentions('小明换上新衣', '小明', names), true);
  assert.equal(textMentions('小明换上新衣', '明', names), false);   // 唯一一次「明」是「小明」的一部分
  assert.equal(textMentions('明换上新衣', '明', names), true);      // 单独出现，确实提到
  assert.equal(textMentions('小明与明都换了衣裳', '明', names), true); // 有一处没被覆盖
  assert.equal(textMentions('换上新衣', '明', names), false);
  assert.equal(textMentions('明：好的', '明', ['小明']), true);
  assert.equal(textMentions('', '明', names), false);
  assert.equal(textMentions('小明换上新衣', '', names), false);
  // canonical 名带身份后缀时，文本里通常只写简称：必须按「规范化后的更长名」去找覆盖，
  // 否则「小明（少年）」盖不住「明」，短名又被误判（真提交一次错误的图生图）。
  assert.equal(textMentions('小明换上新衣', '明', ['小明（少年）', '明']), false);
  assert.equal(nameMatches('小明（少年）', '小明'), true); // 规范化只剥后缀，不是变同一人
  assert.equal(textMentions('小明（少年）换上新衣', '明', ['小明（少年）', '明']), false);
  assert.equal(textMentions('明换上新衣', '明', ['小明（少年）', '明']), true);
  assert.equal(textMentions('小红换上新衣', '明', ['小明（少年）', '明']), false);
});

test('提交生成：失败必须抛给调用方（不再吞错后照弹「已提交」）+ 分阶段加载失败要可见', () => {
  const pv = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ProjectView.jsx'), 'utf8');
  assert.ok(/await api\.post\('\/api\/projects\/' \+ id \+ '\/run'/.test(pv), 'run 仍要提交 /run');
  // run 的函数体里不能有 catch：一旦吞掉失败，调用方拿不到信号就会照弹「已提交…生成」
  const runBody = pv.slice(pv.indexOf('async function run(chapter)'), pv.indexOf('async function stop('));
  assert.ok(runBody.length > 0 && !/catch/.test(runBody), 'ProjectView.run 不该吞掉 /run 的失败（调用方会照弹「已提交…生成」）');
  const cv = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ChaptersView.jsx'), 'utf8');
  assert.ok(/await onRun\(title\)/.test(cv), '章节卡片的「生成」必须走带 catch 的 submitRun');
  assert.ok(!/onRun\(c\.title\)/.test(cv), '不该再有裸 onRun(c.title) 的入口（错误会变成未处理拒绝、点了没反应）');
  const co = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ChapterOps.jsx'), 'utf8');
  assert.ok(/stageLoadErr/.test(co), '分阶段待办拉取失败要有提示，不能永远停在「加载中…」');
});

test('短名串扰：换装/年龄归属都走 textMentions（源码守卫）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent', 'tools.js'), 'utf8');
  assert.ok(!/charIds\.length === 1 \|\| text\.includes\(char\.name\)/.test(src), 'tools.js 不应再用 text.includes(char.name) 判角色归属');
  assert.equal((src.match(/textMentions\(text, char\.name, charNames\)/g) || []).length, 2, '换装与年龄两条归属路径都必须用 textMentions');
});

test('extractJson: 带围栏与噪音', () => {
  const fence = BT.repeat(3);
  assert.deepEqual(extractJson('前置' + fence + 'json\n{"a":1}\n' + fence + '后置'), { a: 1 });
});

test('slugify / ratioToSize', () => {
  assert.equal(slugify('  hello world! '), 'hello_world');
  assert.deepEqual(ratioToSize('16:9'), [1344, 768]);
  assert.deepEqual(ratioToSize('不存在'), [1344, 768]);
});

test('资产分类含服装 costume', () => {
  assert.ok(ASSET_CATEGORIES.some((c) => c.id === 'costume'));
  assert.equal(PROJECT_ASSET_SUBDIRS.costume, 'costumes');
});

test('uploadMediaKind: 分类优先 + 扩展名兜底（gif 归图片、音频扩展名归音频）', () => {
  // 分类优先：voice/music/sfx 是音频、video 是视频
  assert.equal(uploadMediaKind({ category: 'voice' }), 'audio');
  assert.equal(uploadMediaKind({ category: 'music' }), 'audio');
  assert.equal(uploadMediaKind({ category: 'sfx' }), 'audio');
  assert.equal(uploadMediaKind({ category: 'video' }), 'video');
  assert.equal(uploadMediaKind({ category: 'character' }), 'image');
  assert.equal(uploadMediaKind({ category: 'video', ext: '.png' }), 'video', '分类优先于扩展名');
  // 扩展名兜底：上传框不限类型，只看 category 会把 mp3 塞进 image_path
  assert.equal(uploadMediaKind({ category: 'other', ext: '.mp3' }), 'audio');
  assert.equal(uploadMediaKind({ category: 'character', ext: '.wav' }), 'audio');
  assert.equal(uploadMediaKind({ ext: '.MP3' }), 'audio', '扩展名大小写不敏感');
  assert.equal(uploadMediaKind({ category: 'other', ext: '.mp4' }), 'video');
  assert.equal(uploadMediaKind({ category: 'other', ext: '.mkv' }), 'video');
  // gif 是图片：<video> 放不出 gif，references 上传路由也把 gif 当图片
  assert.equal(uploadMediaKind({ category: 'character', ext: '.gif' }), 'image');
  assert.equal(uploadMediaKind({ category: 'other', ext: '.gif' }), 'image');
  assert.equal(uploadMediaKind({ ext: '.png' }), 'image');
  assert.equal(uploadMediaKind({}), 'image');
  assert.equal(uploadMediaKind(), 'image');
});

test('imageToDataUrl: png 编码与拒绝分支', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-img-'));
  const png = path.join(dir, 'a.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  fs.writeFileSync(png, bytes);
  const r = imageToDataUrl(png);
  assert.equal(r.mimeType, 'image/png');
  assert.equal(Buffer.from(r.data, 'base64').toString('hex'), bytes.toString('hex'));
  // 未知扩展
  const txt = path.join(dir, 'a.txt');
  fs.writeFileSync(txt, 'hello');
  assert.equal(imageToDataUrl(txt), null);
  // 不存在
  assert.equal(imageToDataUrl(path.join(dir, 'nope.png')), null);
  // 超大（> maxBytes）
  assert.equal(imageToDataUrl(png, { maxBytes: 3 }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('UPLOAD_MAX_BYTES: 三档上传上限，视频 > 音频 > 图片且都装得进内存', () => {
  // 上传路由把整个请求体读进内存（且默认监听 0.0.0.0）：没有上限时一个误选的大文件
  // 就能把进程撑爆 OOM，所以每一档都必须存在且足够小。
  assert.deepEqual(Object.keys(UPLOAD_MAX_BYTES).sort(), ['audio', 'image', 'video']);
  assert.equal(UPLOAD_MAX_BYTES.image, 20 * 1024 * 1024, '图片 20MB');
  assert.ok(UPLOAD_MAX_BYTES.audio > UPLOAD_MAX_BYTES.image, '音频上限大于图片');
  assert.ok(UPLOAD_MAX_BYTES.video > UPLOAD_MAX_BYTES.audio, '视频上限大于音频');
  assert.ok(UPLOAD_MAX_BYTES.video <= 512 * 1024 * 1024, '视频档也要能安全读进内存');
  // 上限必须覆盖 uploadMediaKind 的全部取值，否则 route 取到 undefined → 永远超限
  for (const kind of ['image', 'audio', 'video']) assert.ok(Number.isFinite(UPLOAD_MAX_BYTES[kind]));
});

test('SKILL_ZIP_MAX_BYTES: 技能包上传也要有上限（同一类 OOM 面）', () => {
  // /api/skills/upload 同样把整个请求体读进内存再解压，没有上限时一个大文件即 OOM。
  assert.equal(SKILL_ZIP_MAX_BYTES, 20 * 1024 * 1024);
  assert.ok(SKILL_ZIP_MAX_BYTES >= 5 * 1024 * 1024, '正常技能包（几十 KB～几 MB）不能被误拦');
});

test('buildVisionUserMessage: 多模态 content 组装', () => {
  const parts = imageUrlParts(['data:image/png;base64,AAAA']);
  assert.deepEqual(parts, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  const withImg = buildVisionUserMessage('hello', ['data:image/png;base64,AAAA']);
  assert.equal(withImg.role, 'user');
  assert.equal(withImg.content[0].text, 'hello');
  assert.deepEqual(withImg.content[1], parts[0]);
  const noImg = buildVisionUserMessage('hello', []);
  assert.equal(noImg.content, 'hello');
});

test('parseFrontmatter + routeSkill', () => {
  const meta = parseFrontmatter('---\nname: x\ndescription: 描述\n---\nbody');
  assert.equal(meta.name, 'x');
  assert.equal(meta.description, '描述');
  assert.equal(routeSkill('一部小说', ''), 'novel-to-video');
  assert.equal(routeSkill('', '3D动画'), '3d-animation-short-generator');
  // 短剧/漫剧路由
  assert.equal(routeSkill('短剧编剧', ''), '0715-scriptwriter');
  assert.equal(routeSkill('小说改编成剧本', ''), 'novel-to-skitscreenplay');
  assert.equal(routeSkill('漫剧前期策划', ''), 'ai-manga-planner');
  assert.equal(routeSkill('年代一致性优化', ''), 'era-consistency-optimizer');
});

test('parseFrontmatter: description: > 折叠块只取到 >，单行描述正常', () => {
  const folded = parseFrontmatter('---\nname: x\ndescription: >\n  多行描述内容\n---\nbody');
  assert.equal(folded.name, 'x');
  assert.equal(folded.description, '>'); // 折叠多行无法被单行解析器识别，需安装前规范化
  const single = parseFrontmatter('---\nname: y\ndescription: 单行中文描述\n---\nbody');
  assert.equal(single.description, '单行中文描述');
});

// —— zip 技能包安装 ——
function zipOf(entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}
function tmpSkillsDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ic-skill-')); }

test('installSkillsFromZip: 单技能位于 zip 顶层', () => {
  const dir = tmpSkillsDir();
  const buf = zipOf({
    'SKILL.md': '---\nname: my-awesome-skill\ndescription: 一个技能\n---\n# 正文',
    'references/guide.md': '参考内容',
  });
  const installed = installSkillsFromZip(buf, { targetDir: dir });
  assert.equal(installed.length, 1);
  assert.equal(installed[0].name, 'my-awesome-skill');
  assert.equal(installed[0].files, 2);
  assert.ok(fs.existsSync(path.join(dir, 'my-awesome-skill', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir, 'my-awesome-skill', 'references', 'guide.md')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installSkillsFromZip: 多技能分文件夹', () => {
  const dir = tmpSkillsDir();
  const buf = zipOf({
    'alpha/SKILL.md': '---\nname: alpha\ndescription: A\n---\n# A',
    'beta/SKILL.cn.md': '---\nname: beta\ndescription: B\n---\n# B',
    'beta/references/r.md': 'r',
  });
  const installed = installSkillsFromZip(buf, { targetDir: dir });
  assert.equal(installed.length, 2);
  assert.deepEqual(installed.map((i) => i.name).sort(), ['alpha', 'beta']);
  assert.ok(fs.existsSync(path.join(dir, 'alpha', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir, 'beta', 'SKILL.cn.md')));
  assert.ok(fs.existsSync(path.join(dir, 'beta', 'references', 'r.md')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installSkillsFromZip: GitHub 风格嵌套目录', () => {
  const dir = tmpSkillsDir();
  const buf = zipOf({
    'repo-main/skills/cool-skill/SKILL.md': '---\nname: cool-skill\ndescription: C\n---\n# C',
    'repo-main/README.md': 'repo readme',
  });
  const installed = installSkillsFromZip(buf, { targetDir: dir });
  assert.equal(installed.length, 1);
  assert.equal(installed[0].name, 'cool-skill');
  assert.ok(fs.existsSync(path.join(dir, 'cool-skill', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'repo-main')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installSkillsFromZip: 拒绝 zip-slip 越界路径', () => {
  const dir = tmpSkillsDir();
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from('---\nname: evil\ndescription: E\n---\n# E', 'utf8'));
  zip.getEntries()[0].entryName = '../evil/SKILL.md';
  const buf = zip.toBuffer();
  assert.throws(() => installSkillsFromZip(buf, { targetDir: dir }), /不安全路径/);
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'evil')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installSkillsFromZip: 拒绝全点/尾点分量（Windows 路径归一化会把它们当 .. 解析）', () => {
  const dir = tmpSkillsDir();
  // Win32 会剥掉每个路径分量结尾的点与空格：'...' / '.. ' 这类分量会被文件系统当成 '..'，
  // 拼出的路径就跳出了目标目录。只拦「精确等于 ..」是不够的。
  for (const evil of ['a/.../evil/SKILL.md', 'a/.. /evil/SKILL.md', '... /SKILL.md']) {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('---\nname: evil\ndescription: E\n---\n# E', 'utf8'));
    zip.getEntries()[0].entryName = evil;
    assert.throws(() => installSkillsFromZip(zip.toBuffer(), { targetDir: dir }), /不安全路径/, evil);
  }
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'evil')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installSkillsFromZip: 无 SKILL.md 时抛错', () => {
  const dir = tmpSkillsDir();
  const buf = zipOf({ 'readme.txt': 'hello' });
  assert.throws(() => installSkillsFromZip(buf, { targetDir: dir }), /未在 zip 中找到/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildVisionContentBlocks: 空图返回纯文本块', () => {
  const blocks = buildVisionContentBlocks('你好', []);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { type: 'text', text: '你好' });
});

test('buildVisionContentBlocks: 文本 + 图片块（Anthropic source.base64）', () => {
  const blocks = buildVisionContentBlocks('看这张图', [{ data: 'abc123', mimeType: 'image/png' }]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: 'text', text: '看这张图' });
  assert.deepEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } });
});

test('buildVisionContentBlocks: 跳过无 data/mimeType 的项', () => {
  const blocks = buildVisionContentBlocks('x', [{ data: '', mimeType: 'image/png' }, null, { data: 'd', mimeType: '' }]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
});

test('filterReferenceImages: 无目标全量 / 指定章过滤', () => {
  const list = [
    { chapter_id: 'c1' },
    { chapter_id: 'c2' },
    { chapter_id: 'c3' },
  ];
  // 生成全部章节：全量
  assert.equal(filterReferenceImages(list, null).length, 3);
  // 指定 c1：只保留 c1
  const r = filterReferenceImages(list, new Set(['c1']));
  assert.deepEqual(r.map((x) => x.chapter_id), ['c1']);
  // 指定 c2：只保留 c2
  const r2 = filterReferenceImages(list, new Set(['c2']));
  assert.deepEqual(r2.map((x) => x.chapter_id), ['c2']);
});

console.log('全部单元测试通过');

// ================= 阶段调度（分阶段运行） =================

test('阶段表：4 项且 each带 need/ck', () => {
  assert.equal(STAGES.length, 4);
  assert.deepEqual(STAGES.map((s) => s.id), ['llm', 'image', 'tts', 'video']);
  for (const s of STAGES) {
    assert.ok(['llm', 'comfyui'].includes(s.need), s.id + ' need 非法');
    assert.ok([true, false, null].includes(s.ck), s.id + ' ck 非法');
    assert.equal(STAGE_MAP[s.id], s);
  }
  // 关键不变式：只有 llm 阶段需要 LLM 进程；只有 video 强制要 CK；只有 image 强制不要 CK
  assert.equal(STAGE_MAP.llm.need, 'llm');
  assert.equal(STAGE_MAP.video.ck, true);
  assert.equal(STAGE_MAP.image.ck, false);
  assert.equal(STAGE_MAP.tts.ck, null, '音色阶段 CK 均可（实测 CK 下 TTS 无问题）');
});

test('ckBroken: 关 CK 一律不坏；开 CK 按 comfy-kitchen 版本判（≥0.2.36 才是坏版本）', () => {
  assert.equal(ckBroken({ ckAttention: false, ckKitchen: '0.2.36' }), false);
  assert.equal(ckBroken({ ckAttention: false, ckKitchen: '9.9.9' }), false);
  assert.equal(ckBroken(null), false);
  // 坏版本下限 = 0.2.36：报告 §6 的版本定位显示 #207/#208 在 0.2.35 之后才落地、随 0.2.36 打包
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.36' }), true);
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.36.1' }), true, '同版本号带后缀也算命中');
  // 0.2.35 及更早走的是 #207 之前的旧 mask 路径，不受影响 —— 拦住它们是误伤（会白丢 2.7x 速度）
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.35' }), false);
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.1.99' }), false);
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.34' }), false);
  // 上游至今没有修复版本 → 比 0.2.36 新的一律保守判坏（宁可拦住，也别默默出一批废图）；
  // 上游修好后要提高下限，或改成「下限 + 最后一个坏版本」的区间。
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.37' }), true);
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '1.0.0' }), true);
  // 读不到版本 -> 保守判坏
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '' }), true);
  // 带后缀的版本号读不准（逐段 Number() 会把 rc1 变 NaN、再被当成 0，于是 0.2.37rc1 被读成 0.2.0
  // 而放行）-> 一律保守判坏，绝不因为「解析不出来」就把可能坏掉的版本放行
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.37rc1' }), true, 'rc 后缀不能被读成 0.2.0');
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.36+cu124' }), true);
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.35rc1' }), true, '读不准宁可拦住（误伤的代价只是少 2.7x 速度，反了就是一批废图）');
});

test('llmChat: 未配 api_key 也能用无鉴权端点（与 preflight 同口径），配了才带 Authorization', async () => {
  const http = await import('node:http');
  const { llmChat } = await import('../lib/core/index.js');
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization || '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    // 本地 llama.cpp 这类端点本来就不发鉴权头：此前 llmChat 无条件要求 apiKey，
    // 结果「preflight 通过、每个 LLM 阶段都报未配置 api_key」。
    const r1 = await llmChat({ baseUrl: base, model: 'm', apiKey: '' }, [{ role: 'user', content: 'x' }]);
    assert.equal(r1.content, '好');
    assert.equal(seen[0].auth, '', '没配 api_key 不该发 Authorization 头');
    await llmChat({ baseUrl: base, model: 'm', apiKey: 'sk-test' }, [{ role: 'user', content: 'x' }]);
    assert.equal(seen[1].auth, 'Bearer sk-test');
    // Base URL 才是必须配的（模型名/键可留空，交给端点自己报错）
    await assert.rejects(() => llmChat({ baseUrl: '', model: 'm', apiKey: 'k' }, [{ role: 'user', content: 'x' }]), /未配置 LLM Base URL/);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('llmChat: 假死（TCP 挂着不响应）报「超时」而不是「无法连接」', async () => {
  const http = await import('node:http');
  const { llmChat } = await import('../lib/core/index.js');
  // 只收请求、永不响应：模拟 LLM 在跑但卡住（模型加载/排队）
  const srv = http.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    await assert.rejects(
      () => llmChat({ baseUrl: base, model: 'm', apiKey: '' }, [{ role: 'user', content: 'x' }], { timeoutMs: 300 }),
      /LLM 响应超时/,
    );
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('renderDisabled：渲染工具被跳过且不抛错（防 Agent 反复重试）', async () => {
  const reports = [];
  const ctx = { renderDisabled: true, report: (x) => reports.push(x) };
  const r = JSON.parse(await runTool(ctx, 'generate_asset_image', { asset_id: 'x' }));
  assert.equal(r.skipped, true);
  assert.equal(r.tool, 'generate_asset_image');
  assert.ok(r.reason.includes('另起一批'));
  assert.equal(reports.length, 1, '跳过时也要上报，否则界面看不出发生了什么');

  // 不开开关时不拦（真的去执行handler，这里会因为无效 asset_id 而失败 —— 证明没被跳过）
  const live = { renderDisabled: false };
  await assert.rejects(() => runTool(live, 'generate_asset_image', { asset_id: 'x' }));
});

test('RENDER_TOOLS 覆盖全部需外部进程的渲染工具', () => {
  for (const n of ['generate_asset_image', 'edit_asset_image', 'change_outfit', 'design_outfits',
    'generate_assets_batch', 'design_voice', 'generate_shot_video', 'regenerate_shot',
    'generate_chapter_videos', 'assemble_video']) {
    assert.ok(RENDER_TOOLS.has(n), n + ' 应属于渲染工具');
  }
  // 纯 DB/文本工具不得被误伤，否则 LLM 阶段连提示词都写不了
  for (const n of ['update_asset', 'set_storyboard', 'list_shots', 'save_context', 'skill', 'report']) {
    assert.equal(RENDER_TOOLS.has(n), false, n + ' 不该被拦');
  }
});

test('待办统计与批量工具口径一致：图片类别不含 costume', () => {
  // costume 走 change_outfit/design_outfits（图生图），不在文生图批处理内
  assert.ok(!IMAGE_ASSET_CATEGORIES.includes('costume'));
  assert.ok(IMAGE_ASSET_CATEGORIES.includes('character'));
  assert.ok(IMAGE_ASSET_CATEGORIES.includes('scene'));
  // ASSET_CATEGORY_IDS 里真实存在的类别不能写错
  for (const c of IMAGE_ASSET_CATEGORIES) assert.ok(ASSET_CATEGORIES.some((x) => x.id === c), c + ' 不是合法资产类别');
});

// ================= 显存释放（/free） =================

test('freeComfy: POST /free 携带 unload_models + free_memory', async () => {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method, body: opts?.body });
    return { ok: true, json: async () => ({}) };
  };
  try {
    await freeComfy('http://127.0.0.1:8188/');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:8188/free', 'baseUrl 尾部斜杠应被归一');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].body), { unload_models: true, free_memory: true });
  } finally {
    global.fetch = orig;
  }
});

test('checkComfyUI: dynamicVram 探测（--disable-dynamic-vram 关闭，否则开启）', async () => {
  const orig = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ system: { comfyui_version: '0.3.x', argv: ['python', 'main.py', '--use-ck-attention'] }, devices: [{ name: 'RX 7900 XTX', vram_free: 100 }] }) });
    const on = await checkComfyUI('http://x');
    assert.equal(on.ok, true);
    assert.equal(on.dynamicVram, true);
    assert.equal(on.ckAttention, true);

    global.fetch = async () => ({ ok: true, json: async () => ({ system: { argv: ['python', 'main.py', '--disable-dynamic-vram'] }, devices: [] }) });
    const off = await checkComfyUI('http://x');
    assert.equal(off.ok, true);
    assert.equal(off.dynamicVram, false);
  } finally {
    global.fetch = orig;
  }
});

// —— 截断/停滞看门狗（防「Response truncated 后任务永远 running」）——
const truncMsg = () => ({ type: 'assistant', message: { content: [{ type: 'text', text: '\n\n[Response truncated — reached length limit or upstream stalled. Ask the model to continue.]' }] } });
const toolMsg = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'generateImage', input: {} }] } });
const plainMsg = () => ({ type: 'assistant', message: { content: [{ type: 'text', text: '正常输出' }] } });
const toolResultMsg = () => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }] } });
const multiToolMsg = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'report', input: {} }, { type: 'tool_use', name: 'generate_chapter_videos', input: {} }] } });

test('isTruncatedText: 识别 openclaude 截断标记', () => {
  assert.equal(isTruncatedText('[Response truncated — reached length limit or upstream stalled. Ask the model to continue.]'), true);
  assert.equal(isTruncatedText('Response truncated'), true);
  assert.equal(isTruncatedText('正常输出'), false);
  assert.equal(isTruncatedText(''), false);
  assert.equal(isTruncatedText(null), false);
});

test('classifyAgentMsg: 截断/工具/正常文本分类', () => {
  assert.deepEqual(classifyAgentMsg(truncMsg()), { hasToolUse: false, hasTrunc: true, hasPlainText: false, toolUseCount: 0, toolResultCount: 0 });
  assert.deepEqual(classifyAgentMsg(toolMsg()), { hasToolUse: true, hasTrunc: false, hasPlainText: false, toolUseCount: 1, toolResultCount: 0 });
  assert.deepEqual(classifyAgentMsg(plainMsg()), { hasToolUse: false, hasTrunc: false, hasPlainText: true, toolUseCount: 0, toolResultCount: 0 });
  assert.deepEqual(classifyAgentMsg(toolResultMsg()), { hasToolUse: false, hasTrunc: false, hasPlainText: false, toolUseCount: 0, toolResultCount: 1 });
  assert.deepEqual(classifyAgentMsg({ type: 'result', result: 'x' }), { hasToolUse: false, hasTrunc: false, hasPlainText: false, toolUseCount: 0, toolResultCount: 0 });
  assert.deepEqual(classifyAgentMsg(null), { hasToolUse: false, hasTrunc: false, hasPlainText: false, toolUseCount: 0, toolResultCount: 0 });
});

test('watchdogStep: 连续纯截断 3 次熔断', () => {
  const t0 = 1_000_000;
  let st = { lastAt: t0, pendingTools: 0, truncStreak: 0 };
  // 第 1、2 次截断：不熔断，streak 递增
  st = watchdogStep(st, truncMsg(), t0 + 1000).next;
  assert.equal(st.truncStreak, 1);
  st = watchdogStep(st, truncMsg(), t0 + 2000).next;
  assert.equal(st.truncStreak, 2);
  // 第 3 次截断：熔断
  const r = watchdogStep(st, truncMsg(), t0 + 3000);
  assert.ok(r.halted, '第 3 次连续截断应熔断');
  assert.match(r.halted, /连续被截断/);
});

test('watchdogStep: 中间有工具调用/正常文本则重置截断计数', () => {
  let st = { lastAt: 0, pendingTools: 0, truncStreak: 0 };
  st = watchdogStep(st, truncMsg(), 1000).next;
  assert.equal(st.truncStreak, 1);
  // 工具调用 = 实质进展，streak 归零
  st = watchdogStep(st, toolMsg(), 2000).next;
  assert.equal(st.truncStreak, 0);
  // 正常文本 = 实质进展，streak 归零
  st = watchdogStep(st, truncMsg(), 3000).next;
  assert.equal(st.truncStreak, 1);
  st = watchdogStep(st, plainMsg(), 4000).next;
  assert.equal(st.truncStreak, 0);
});

test('watchdogStep: 停滞超时熔断（非工具窗口）', () => {
  const now = 5_000_000;
  let st = { lastAt: now - AGENT_WATCHDOG.STALL_MS - 1000, pendingTools: 0, truncStreak: 0 };
  const r = watchdogStep(st, plainMsg(), now);
  assert.ok(r.halted, '间隔超过 STALL_MS 且非工具窗口应判停滞');
  assert.match(r.halted, /停滞/);
});

test('watchdogStallCheck: 工具执行窗口豁免，非工具窗口超时判定', () => {
  const now = 5_000_000;
  // 有待执行工具 → 不判停滞（渲染可能很久）
  assert.equal(watchdogStallCheck({ lastAt: now - 3600_000, pendingTools: 1, truncStreak: 0 }, now), null);
  // 非工具窗口超时 → 判停滞
  assert.ok(watchdogStallCheck({ lastAt: now - AGENT_WATCHDOG.STALL_MS - 1, pendingTools: 0, truncStreak: 0 }, now));
  // 非工具窗口未超时 → 不判停滞
  assert.equal(watchdogStallCheck({ lastAt: now - 1000, pendingTools: 0, truncStreak: 0 }, now), null);
});

test('watchdogStep: 同一轮多个工具时，慢工具运行期间不误判停滞', () => {
  const t0 = 1_000_000;
  let st = { lastAt: t0, pendingTools: 0, truncStreak: 0 };
  // 一条 assistant 消息同时带 report + generate_chapter_videos 两个 tool_use
  st = watchdogStep(st, multiToolMsg(), t0).next;
  assert.equal(st.pendingTools, 2);
  // report（快工具）先返回，只剩 generate_chapter_videos 仍在渲染
  st = watchdogStep(st, toolResultMsg(), t0 + 1000).next;
  assert.equal(st.pendingTools, 1);
  // 慢工具渲染超过 STALL_MS，仍应豁免（pendingTools>0）
  const t1 = t0 + 1000 + AGENT_WATCHDOG.STALL_MS + 60_000;
  assert.equal(watchdogStallCheck(st, t1), null, '仍有工具在运行，不应判停滞');
  // 慢工具也返回后，pendingTools 归零
  st = watchdogStep(st, toolResultMsg(), t1).next;
  assert.equal(st.pendingTools, 0);
});

test('watchdogStep: 截断后可恢复（截断→工具→截断→截断不熔断）', () => {
  let st = { lastAt: 0, pendingTools: 0, truncStreak: 0 };
  st = watchdogStep(st, truncMsg(), 1000).next;   // streak 1
  st = watchdogStep(st, toolMsg(), 2000).next;    // 归零
  st = watchdogStep(st, truncMsg(), 3000).next;   // streak 1
  st = watchdogStep(st, toolMsg(), 4000).next;    // 归零
  const r = watchdogStep(st, truncMsg(), 5000);   // streak 1，不熔断
  assert.equal(r.halted, null);
  assert.equal(r.next.truncStreak, 1);
});

// —— 主动查询任务状态（不干等分钟级超时兜底） ——

test('runFfmpeg：合并途中被停止 → 杀掉子进程，不再空等整次合并跑完', async () => {
  const out = path.join(os.tmpdir(), 'ic-ffmpeg-abort-' + Date.now() + '.mp4');
  let aborted = false;
  setTimeout(() => { aborted = true; }, 300);
  const t0 = Date.now();
  try {
    await assert.rejects(
      () => runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=600:size=640x360:rate=25', '-c:v', 'libx264', '-preset', 'slow', out], { isAborted: () => aborted, timeoutMs: 60000 }),
      /已停止/,
    );
    assert.ok(Date.now() - t0 < 15000, '停止后必须很快退出（长章节合并可达数分钟）');
  } finally {
    try { fs.unlinkSync(out); } catch {}
  }
});

test('generate: 主动查询——任务从 ComfyUI 队列消失则主动失败（不干等 timeoutMs）', async () => {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/prompt')) return { ok: true, json: async () => ({ prompt_id: 'lost-1' }) };
    if (u.includes('/history/')) return { ok: true, json: async () => ({}) }; // 查不到产出
    if (u.includes('/queue')) return { ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) }; // 也不在队列
    return { ok: true, json: async () => ({}) };
  };
  try {
    await assert.rejects(
      generate('http://127.0.0.1:1', { n1: {} }, { timeoutMs: 10_000, pollMs: 2 }),
      /任务丢失/,
    );
  } finally {
    global.fetch = orig;
  }
});

test('generate: 提交失败（ComfyUI 校验失败）时必须关掉 WebSocket，不泄漏长连接', async () => {
  const origFetch = global.fetch;
  const origWS = global.WebSocket;
  const sockets = [];
  class FakeWS {
    constructor() { this.closed = false; this.onmessage = null; this.onerror = null; this.onclose = null; sockets.push(this); }
    close() { this.closed = true; }
  }
  global.WebSocket = FakeWS;
  // 提交阶段就失败（校验失败是最典型的一种）：原先 ws 建连在 try 内、queuePrompt 在 try 外，
  // 这里一抛错就没人关这条连接；上层对同一分镜还会重试多次，泄漏随失败数线性累积。
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/prompt')) return { ok: true, json: async () => ({ error: { type: 'prompt_outputs_failed_validation' }, node_errors: { '3': { errors: ['bad'] } } }) };
    return { ok: true, json: async () => ({}) };
  };
  try {
    await assert.rejects(() => generate('http://127.0.0.1:1', { n1: {} }, { timeoutMs: 5000, pollMs: 2 }), /校验失败/);
    assert.equal(sockets.length, 1, '应建立过一条 WS');
    assert.equal(sockets[0].closed, true, '提交失败时 WS 必须被关闭');
  } finally {
    global.fetch = origFetch;
    global.WebSocket = origWS;
  }
});

test('runExclusiveVideo: 排队等待中被停止→主动拒绝；排队超时→主动放弃', async () => {
  // 占满全部渲染槽位（本地默认 1，云端 RunningHub 按 runninghubConcurrency），让后续任务进入排队分支
  const limit = concurrencyLimit(loadConfig());
  const holders = [];
  const releaseFns = [];
  for (let i = 0; i < limit; i++) {
    const blocked = new Promise((r) => { releaseFns.push(r); });
    holders.push(runExclusiveVideo(() => blocked));
  }
  // 闸门状态必须挂 globalThis：模块级变量在 Next dev 下每个 route 各一份 → 会真并发
  assert.ok(globalThis.__infiniteCreationVideoGate, '槽位与队列应挂在 globalThis 上共享');

  // 排队前已带停止标记 → 直接拒绝，不进队列
  await assert.rejects(
    runExclusiveVideo(() => Promise.resolve('不该跑'), () => true),
    /已被停止/,
  );

  // 排队中等待超时（queueTimeoutMs=30ms）→ 主动放弃而不是无限等
  const t0 = Date.now();
  await assert.rejects(
    runExclusiveVideo(() => Promise.resolve('不该跑'), () => false, { queueTimeoutMs: 30 }),
    /等待视频槽位超时/,
  );
  assert.ok(Date.now() - t0 >= 25, '应确实等待了排队超时');

  // 释放占位任务，清理槽位
  releaseFns.forEach((release) => release());
  await Promise.all(holders.map((h) => h.catch(() => {})));
});

test('runExclusiveVideo: 不看服务状态——没有任务在跑时立即执行，且不做任何服务探测', async () => {
  const orig = global.fetch;
  let probes = 0;
  global.fetch = async () => { probes++; return { ok: true }; };
  try {
    // 关键回归：以前 need='comfyui' 会在本机 LLM 也在跑时把任务挂成「等待服务」直到用户关掉 LLM。
    // 现在即便两侧服务都在跑，没有别的任务占用槽位就必须立即执行。
    let ran = false;
    const r = await runExclusiveVideo(async () => { ran = true; return 'ok'; }, () => false, { need: 'comfyui' });
    assert.equal(r, 'ok');
    assert.equal(ran, true, '没有其他任务时必须立即执行（不排队、不等待）');
    assert.equal(probes, 0, '不得探测 LLM /models 或 ComfyUI /system_stats —— 服务状态不参与调度');
  } finally { global.fetch = orig; }
});

test('holdsRenderSlot: 只有真正占着渲染槽位的任务为真（行内任务/排队中/已结束都为假）', async () => {
  assert.equal(holdsRenderSlot(''), false);
  assert.equal(holdsRenderSlot(undefined), false, 'jobId 缺失不应抛错');
  assert.equal(holdsRenderSlot('never-ran'), false, '没跑过的任务不占槽位');
  assert.ok(globalThis.__infiniteCreationVideoGate.holders instanceof Set, '持有者集合也要挂 globalThis（Next dev 每个 route 一份模块）');

  // 占满全部槽位（本地默认 1）：持有者算占用，后面的任务只能排队——排队 ≠ 占用
  const limit = concurrencyLimit(loadConfig());
  const releases = [];
  const blockers = [];
  for (let i = 0; i < limit; i++) {
    const blocked = new Promise((r) => { releases.push(r); });
    blockers.push(runExclusiveVideo(() => blocked, () => false, { jobId: 'r-block-' + i }));
  }
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(holdsRenderSlot('r-block-0'), true, '拿到槽位即视为占用（取消它才该打断 ComfyUI）');

  let ran = false;
  const queued = runExclusiveVideo(async () => { ran = true; }, () => false, { jobId: 'r-wait' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(holdsRenderSlot('r-wait'), false, '排队中还没拿到槽位，不得当成占用（否则取消排队任务会误打断前排）');
  assert.equal(ran, false, '槽位被占满时不得开跑');

  releases.forEach((r) => r());
  await Promise.all([...blockers, queued]);
  assert.equal(ran, true);
  assert.equal(holdsRenderSlot('r-block-0'), false, '释放槽位后必须为假');
  assert.equal(holdsRenderSlot('r-wait'), false, '跑完也必须为假');
});

test('取消/删除任务：只有占着渲染槽位的任务才打断 ComfyUI（行内任务不再误杀别人的渲染）', () => {
  // 行内任务（runInlineJob：llm 参考图分析 / export 按章导出）在请求内同步执行、不进闸门、
  // 也没人读它的停止标记，但状态同样是 running。旧代码用「状态是 running」决定 /interrupt，
  // 于是取消/删除它们会把**当时真正在跑的渲染任务**（全局槽位串行，可能是另一个项目的整片生成）
  // 打断成 failed。这里钉住「用 holdsRenderSlot 决定是否打断」+「行内任务如实拒绝」。
  const read = (...segs) => fs.readFileSync(path.join(__dirname, '..', ...segs), 'utf8');
  const cancel = read('app', 'api', 'projects', '[id]', 'jobs', '[jobId]', 'cancel', 'route.js');
  assert.ok(/holdsRenderSlot\(jobId\)/.test(cancel), '取消：running 要看是否真占槽位');
  assert.ok(/不占渲染队列/.test(cancel), '取消行内任务要如实拒绝（409），不能假成功');
  assert.ok(cancel.indexOf('holdsRenderSlot(jobId)') < cancel.indexOf('await interruptTask(cfg)'), '判断必须发生在打断之前');

  const del = read('app', 'api', 'projects', '[id]', 'jobs', '[jobId]', 'route.js');
  assert.ok(/holdsRenderSlot\(jobId\)/.test(del), '删除任务记录：行内任务同步执行中不得删记录（会成为看不见的孤儿）');
  assert.ok(del.indexOf('holdsRenderSlot(jobId)') < del.indexOf('await interruptTask(cfg)'), '判断必须发生在打断之前');

  const stop = read('app', 'api', 'projects', '[id]', 'stop', 'route.js');
  assert.ok(/jobs\.some\(\(j\) => holdsRenderSlot\(j\.id\)\)/.test(stop), '/stop 只在本项目确实占槽位时才打断');
  assert.ok(stop.indexOf('holdsRenderSlot(j.id)') < stop.indexOf('await interruptTask(cfg)'), '判断必须发生在打断之前');

  const project = read('app', 'api', 'projects', '[id]', 'route.js');
  assert.ok(/active\.some\(\(j\) => holdsRenderSlot\(j\.id\)\)/.test(project), '删项目同上（否则删一个只有行内任务的项目会打断别的项目）');
  assert.ok(project.indexOf('holdsRenderSlot(j.id)') < project.indexOf('await interruptTask(loadConfig())'), '判断必须发生在打断之前');
});

test('variantReusable / variantPrompt: 变体内容或提示词改过就必须重做，并用用户改过的提示词', () => {
  const done = (over) => ({ image_path: 'a.png', status: 'done', description: '校服', prompt: 'P', prompt_used: 'P', ...over });
  // 内容与提示词都没变 → 复用（幂等，避免每次写分镜都重渲染一遍衣橱）
  assert.equal(variantReusable(done(), '校服', undefined), true);
  assert.equal(variantReusable(done(), '校服', 'P'), true);
  assert.equal(variantReusable(null, '校服', undefined), false);
  assert.equal(variantReusable(done({ status: 'pending' }), '校服', undefined), false, '没出过图不能复用');
  assert.equal(variantReusable(done({ image_path: '' }), '校服', undefined), false);
  assert.equal(variantReusable(done(), '西装', undefined), false, '服装描述改了 → 必须重做');
  // 用户在前端改过提示词（prompt ≠ prompt_used）→ 必须重做，否则用户的修改被旧图吞掉
  assert.equal(variantReusable(done({ prompt: '用户改的' }), '校服', undefined), false);
  // 调用方显式指定提示词且与库里不同 → 重做
  assert.equal(variantReusable(done(), '校服', '别的'), false);

  // 提示词取值：调用方显式 > 用户改过的 > 兜底
  assert.equal(variantPrompt(done({ prompt: '用户改的' }), undefined, '兜底'), '用户改的');
  assert.equal(variantPrompt(done(), undefined, '兜底'), '兜底', '没改过时不要把旧提示词当新指令');
  assert.equal(variantPrompt(done({ prompt: '用户改的' }), '显式', '兜底'), '显式');
  assert.equal(variantPrompt(null, undefined, '兜底'), '兜底');
});

test('keepsUserPrompt: 用户手动保存过的提示词是权威，LLM 不得覆盖', () => {
  assert.equal(keepsUserPrompt({ prompt: '用户写的', prompt_locked: 1 }), true);
  assert.equal(keepsUserPrompt({ prompt: 'LLM 写的', prompt_locked: 0 }), false);
  assert.equal(keepsUserPrompt({ prompt: '', prompt_locked: 1 }), false, '清空保存 = 解锁，允许 LLM 重写');
  assert.equal(keepsUserPrompt(null), false);
});

// —— TTS 音色性别/年龄兜底推断 ——

test('inferVoiceBaseline: 青年男性/少女/老年男性 推断出带性别的音色描述', () => {
  assert.match(inferVoiceBaseline('林峰', '青年男性剑客，长身玉立'), /青年男性/);
  assert.match(inferVoiceBaseline('沈舒妍', '16岁的少女，活泼可爱'), /少女/);
  assert.match(inferVoiceBaseline('张老伯', '六十岁的老翁，白发苍苍'), /老年男性/);
  assert.match(inferVoiceBaseline('苏婉', '年轻的女子，温婉有礼'), /青年女性|青年女性/);
});

test('inferVoiceBaseline: 推断不出性别（中性/冲突）返回空串，由调用方决定跳过或中性兜底', () => {
  assert.equal(inferVoiceBaseline('一盏路灯', '立在巷口的老路灯'), '');
  assert.equal(inferVoiceBaseline('路人甲', '没有性别标志的剪影'), '');
  // 性别词冲突（如「男主角的女友」同时含男女）：保守返回空，避免给错性别
  assert.equal(inferVoiceBaseline('某角色', '男主角的女友，温柔'), '');
});

test('guardToolCall: 危险命令只扫非正文参数（创作文本不该被误拦）', () => {
  // 台词/画面描述里出现命令字样：本项目没有任何能执行命令的工具，这类拦截只会误伤合法写入
  const prose = guardToolCall('set_storyboard', {
    shots: [{ idx: 1, chapter: '第1章', visual: '他敲下 rm -rf / 清空服务器', dialogue: '张工：快执行 chmod 777！', sub_shots: 'git reset --hard' }],
  });
  assert.equal(prose.blocked, false, '创作正文里的命令字样不该拦');

  // 非正文字段/未知字段仍然照常扫描（默认检查，防御性不下降）
  assert.equal(guardToolCall('some_tool', { command: 'rm -rf /tmp/x', note: 'y' }).blocked, true);
  assert.equal(guardToolCall('set_storyboard', { shots: [{ idx: 1, visual: 'x' }], cmd: 'sudo su -' }).blocked, true);
});

test('guardToolCall: 路径穿越仍按路径类参数拦截（与正文无关）', () => {
  assert.equal(guardToolCall('edit_asset_image', { file_path: '../../etc/passwd' }).blocked, true);
  assert.equal(guardToolCall('edit_asset_image', { reference_image_path: '/etc/passwd' }).blocked, true);
  // Windows 形态的绝对路径/盘符相对路径：运行平台是 win32，只认 POSIX 等于守卫形同虚设
  assert.equal(guardToolCall('edit_asset_image', { file_path: 'C:\\Windows\\win.ini' }).blocked, true);
  assert.equal(guardToolCall('edit_asset_image', { file_path: 'C:../x' }).blocked, true);
  assert.equal(guardToolCall('edit_asset_image', { file_path: '\\\\server\\share\\x' }).blocked, true);
  // 路径穿越只在路径类参数上判：普通文本里出现 ../ 不算（例如正文提及相对路径）
  assert.equal(guardToolCall('set_storyboard', { shots: [{ visual: '她从 ../ 的岔路口走来' }] }).blocked, false);
});

// ==================== 第 6 轮审计：停止语义 ====================
// generate 会开 WebSocket 订阅 ComfyUI 事件；单测里没有 ComfyUI，用哑实现顶掉（只用它的 close/onmessage）。
class DummyWS { constructor() {} close() {} set onmessage(_) {} }

test('generate：已停止时不再提交任务（提交出去的项目 /interrupt 管不到，会被 ComfyUI 挨个执行）', async () => {
  const calls = [];
  const origFetch = globalThis.fetch, origWS = globalThis.WebSocket;
  globalThis.WebSocket = DummyWS;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: String(opts?.body || '') });
    return new Response('{"prompt_id":"pid-pre"}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await assert.rejects(() => generate('http://127.0.0.1:9', {}, { isAborted: () => true }), /任务已停止/);
    assert.equal(calls.filter((c) => c.url.includes('/prompt')).length, 0, '已停止就不该再 POST /prompt');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.WebSocket = origWS;
  }
});

test('generate：运行中被停止 → 既打断当前项，也删掉自己还没执行的队列项', async () => {
  const calls = [];
  const origFetch = globalThis.fetch, origWS = globalThis.WebSocket;
  globalThis.WebSocket = DummyWS;
  let aborted = false;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts?.method || 'GET', body: String(opts?.body || '') });
    if (u.includes('/prompt')) return new Response('{"prompt_id":"pid-run"}', { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/queue') && (opts?.method || 'GET') === 'GET') return new Response('{"queue_running":[],"queue_pending":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    // 提交成功那一刻就置位停止标记：走「提交后立即检查 → abort()」这条路
    await assert.rejects(
      () => generate('http://127.0.0.1:9', {}, { isAborted: () => aborted, onSubmitted: () => { aborted = true; }, pollMs: 5 }),
      /任务已停止/,
    );
    assert.ok(calls.some((c) => c.url.endsWith('/interrupt')), '必须打断正在执行的那一张');
    const del = calls.find((c) => c.url.endsWith('/queue') && c.method === 'POST');
    assert.ok(del, '/interrupt 只打断当前项，排队项必须按 prompt_id 删掉');
    assert.match(del.body, /pid-run/);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.WebSocket = origWS;
  }
});

test('deleteQueued：空 id 不发请求；有 id 才 POST /queue {"delete":[...]}（ComfyUI server.py post_queue）', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: String(opts?.body || '') });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await deleteQueued('http://127.0.0.1:9', []);
    assert.equal(calls.length, 0, '没有 id 时不该打 ComfyUI');
    await deleteQueued('http://127.0.0.1:9', ['a', '', null, 'b']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/queue$/);
    assert.deepEqual(JSON.parse(calls[0].body), { delete: ['a', 'b'] });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('素材分类下拉：与写入端值域同源，且不遗漏 age（下拉缺 age 会建不出/改不了年龄变体）', () => {
  const ids = CATEGORIES.map(([k]) => k);
  assert.deepEqual(ids, ASSET_CATEGORIES.map((c) => c.id), '下拉分类必须与 lib/shared 的值域完全一致');
  assert.ok(ids.includes('age'), '下拉必须能选「年龄/时期」（原来手写清单漏了 age）');
  assert.deepEqual(CATEGORIES.map(([, l]) => l), ASSET_CATEGORIES.map((c) => c.label), '显示名不得与 ASSET_CATEGORIES 漂移');
  // 下拉是 [id, label] 成对结构，Tab/SelectItem 都按它对解构
  for (const c of CATEGORIES) assert.equal(c.length, 2, '分类项必须是 [id, label] 两元组');
});

// —— 分支审计（dev7 相对 origin/main）的回归：写入契约与执行顺序 ——

test('set_storyboard：工具描述与「章节必须存在」的校验同口径（模型按描述传参不能必错）', () => {
  // 校验（tools.js hSetStoryboard）只认章节标题或 id，但描述一直写着「chapter 传章节号」：
  // 模型照描述传 "1" / "2" 会让**整批**分镜被拒（一条都不落库）。描述必须给出可用的取值形态。
  const sb = TOOL_DEFINITIONS.find((t) => t.function.name === 'set_storyboard');
  assert.ok(sb, '找不到 set_storyboard 工具定义');
  assert.match(sb.function.description, /chapter 传章节标题或章节 id/, '描述要写明可传标题或 id');
  assert.doesNotMatch(sb.function.description, /chapter 传章节号/, '不能再写「章节号」——校验不接受纯序号');
});

test('资产图阶段：批量出图排在换装/年龄兜底之前（兜底是图生图，要先有角色 canonical 图）', () => {
  // 兜底（hChangeOutfit / hChangeAge）在角色 canonical 图不存在时直接抛「角色参考图不存在」。
  // 它原先排在批量出图之前 → 新项目首次跑资产图阶段时每个变体都失败（只落进 notes），要再跑
  // 一次才生效；顺序反了不报错，所以只能钉住源码顺序。
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent', 'stages.js'), 'utf8');
  const stage = src.slice(src.indexOf('async image(ctx)'));
  const batch = stage.indexOf("'generate_assets_batch'");
  const prov = stage.indexOf('resolveShotProvisions');
  assert.ok(batch > -1 && prov > -1, '资产图阶段应同时包含批量出图与换装/年龄兜底');
  assert.ok(batch < prov, '必须先批量出图，再跑换装/年龄兜底');
});

test('任务列表：运行中的行内任务（llm/export）不渲染「删除」（后端明确 409，按钮必然报错）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'pages', 'ProjectView.jsx'), 'utf8');
  const delLine = src.split('\n').find((l) => l.includes('>删除</Button>'));
  assert.ok(delLine, '找不到任务列表的删除按钮');
  assert.match(delLine, /CANCELLABLE/, '删除按钮必须排除「后端拒绝删除的运行中行内任务」');
});

// —— 小说拆分章节（创建项目时自动拆分长篇小说） ——

test('splitNovelIntoChapters：空文本返回空数组', () => {
  assert.deepEqual(splitNovelIntoChapters(''), []);
  assert.deepEqual(splitNovelIntoChapters('   \n  '), []);
});

test('splitNovelIntoChapters：短文本保持单章', () => {
  const out = splitNovelIntoChapters('一句话描述故事');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, '第1章');
  assert.equal(out[0].novel, '一句话描述故事');
});

test('splitNovelIntoChapters：识别中文章节标题并切分', () => {
  const novel = '第一章 初入江湖\n正文A\n第二章 风起\n正文B\n第三章\n正文C';
  const out = splitNovelIntoChapters(novel);
  assert.equal(out.length, 3);
  assert.equal(out[0].title, '第一章');
  assert.equal(out[0].novel, '正文A');
  assert.equal(out[1].title, '第二章');
  assert.equal(out[1].novel, '正文B');
  assert.equal(out[2].title, '第三章');
  assert.equal(out[2].novel, '正文C');
});

test('splitNovelIntoChapters：识别阿拉伯数字与英文标题', () => {
  const novel = '第1章 开始\n内容一\nChapter 2\ncontent two';
  const out = splitNovelIntoChapters(novel);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '第1章');
  assert.equal(out[0].novel, '内容一');
  assert.equal(out[1].title, 'Chapter 2');
  assert.equal(out[1].novel, 'content two');
});

test('splitNovelIntoChapters：前言并入第一段', () => {
  const novel = '前言文字\n第一章 开场\n正文A\n第二章\n正文B';
  const out = splitNovelIntoChapters(novel);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '第一章');
  assert.equal(out[0].novel, '前言文字\n\n正文A');
  assert.equal(out[1].title, '第二章');
  assert.equal(out[1].novel, '正文B');
});

test('splitNovelIntoChapters：重复标题追加后缀去重', () => {
  const novel = '第一章\na\n第一章\nb';
  const out = splitNovelIntoChapters(novel);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '第一章');
  assert.equal(out[1].title, '第一章·(2)');
});

test('splitNovelIntoChapters：无标题且超长按字数均分', () => {
  const chunk = '字'.repeat(100);
  const novel = chunk.repeat(3); // 300 字，设 fallbackChars=100 → 3 章
  const out = splitNovelIntoChapters(novel, { fallbackChars: 100 });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.title), ['第1章', '第2章', '第3章']);
  assert.equal(out[0].novel.length, 100);
  assert.equal(out[2].novel.length, 100);
});

test('splitNovelIntoChapters：字数兜底按段落（换行符）切分，不切断句子', () => {
  const para = '完整段落内容不会被切断。';
  const lines = Array.from({ length: 10 }, () => para); // 10 段
  const novel = lines.join('\n');
  const out = splitNovelIntoChapters(novel, { fallbackChars: 30 });
  assert.ok(out.length > 1, '超长文本应拆成多章');
  for (const c of out) {
    assert.ok(c.novel.split('\n').every((p) => p === para), '每章内容必须由完整段落组成，切分点只能在换行符处');
  }
  const totalParas = out.reduce((s, c) => s + c.novel.split('\n').length, 0);
  assert.equal(totalParas, lines.length, '拆分后段落总数不能丢失');
});

test('filterReferenceImages：shared 参考图在所有章节生效', () => {
  const list = [
    { id: 'r1', chapter_id: 'c1', shared: 0 },
    { id: 'r2', chapter_id: 'c1', shared: 1 },
    { id: 'r3', chapter_id: 'c2', shared: 0 },
  ];
  // 指定 c2：保留 c2 自己的 + 所有 shared
  const c2 = filterReferenceImages(list, new Set(['c2'])).map((r) => r.id);
  assert.deepEqual(c2, ['r2', 'r3']);
  // 指定 c1：保留 c1 自己的 + shared
  const c1 = filterReferenceImages(list, new Set(['c1'])).map((r) => r.id);
  assert.deepEqual(c1, ['r1', 'r2']);
  // 全量：全部返回
  assert.equal(filterReferenceImages(list, null).length, 3);
});

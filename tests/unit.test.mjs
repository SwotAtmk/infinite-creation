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
  extractJson, slugify, imageToDataUrl, buildVisionUserMessage, imageUrlParts, buildVisionContentBlocks,
  freeComfy, checkComfyUI, generate, queuePrompt, getHistory, interrupt, downloadOutput, getObjectInfo, resolveHardwareConfig, HW_PRESETS, loadConfig,
  toOutputItem, runninghubSubmit, generateTask, uploadTaskInput, downloadTaskOutput, checkBackend, freeBackend, interruptTask, DEFAULT_SPECS,
} from '../lib/core/index.js';
import { ratioToSize, ASSET_CATEGORIES, PROJECT_ASSET_SUBDIRS, filterReferenceImages, isTruncatedText, classifyAgentMsg, watchdogStep, watchdogStallCheck, AGENT_WATCHDOG, inferVoiceBaseline, HW_PRESETS as SHARED_HW_PRESETS, isPresetWorkflows, presetModeOf, comfyBaseUrl, maskComfyBaseUrl } from '../lib/shared/index.js';
import { parseFrontmatter, routeSkill, installSkillsFromZip } from '../lib/agent/index.js';
import { ckBroken, STAGES, STAGE_MAP, preflight } from '../lib/agent/stages.js';
import { RENDER_TOOLS, IMAGE_ASSET_CATEGORIES, runTool, variantReusable, variantPrompt, keepsUserPrompt } from '../lib/agent/tools.js';
import { runExclusiveVideo, concurrencyLimit } from '../lib/agent/job-runner.js';
import { guardToolCall } from '../lib/agent/guard.js';

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

test('ckBroken: 关 CK 一律不坏；开 CK 按 comfy-kitchen 版本判', () => {
  assert.equal(ckBroken({ ckAttention: false, ckKitchen: '0.2.36' }), false);
  assert.equal(ckBroken({ ckAttention: false, ckKitchen: '9.9.9' }), false);
  assert.equal(ckBroken(null), false);
  // 已知坏区间
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.36' }), true);
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.35' }), true);
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.1.99' }), true);
  // 修好的版本自动放行（上游修好后改 CK_BAD_MAX 即可，其余代码不用动）
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '0.2.37' }), false);
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '1.0.0' }), false);
  // 读不到版本 -> 保守判坏
  assert.equal(ckBroken({ ckAttention: true, ckKitchen: '' }), true);
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
  // 路径穿越只在路径类参数上判：普通文本里出现 ../ 不算（例如正文提及相对路径）
  assert.equal(guardToolCall('set_storyboard', { shots: [{ visual: '她从 ../ 的岔路口走来' }] }).blocked, false);
});

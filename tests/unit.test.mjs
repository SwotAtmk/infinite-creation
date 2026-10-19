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
  toOutputItem, runninghubSubmit, generateTask, uploadTaskInput, downloadTaskOutput, checkBackend, freeBackend, interruptTask,
} from '../lib/core/index.js';
import { ratioToSize, ASSET_CATEGORIES, PROJECT_ASSET_SUBDIRS, filterReferenceImages, isTruncatedText, classifyAgentMsg, watchdogStep, watchdogStallCheck, AGENT_WATCHDOG, inferVoiceBaseline, HW_PRESETS as SHARED_HW_PRESETS, isPresetWorkflows, comfyBaseUrl, maskComfyBaseUrl } from '../lib/shared/index.js';
import { parseFrontmatter, routeSkill, installSkillsFromZip } from '../lib/agent/index.js';
import { ckBroken, STAGES, STAGE_MAP, preflight } from '../lib/agent/stages.js';
import { RENDER_TOOLS, IMAGE_ASSET_CATEGORIES, runTool, variantReusable, variantPrompt, keepsUserPrompt } from '../lib/agent/tools.js';
import { runExclusiveVideo, concurrencyLimit } from '../lib/agent/job-runner.js';

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

test('comfyBaseUrl: native 返回原地址，runninghub 返回固定域名，api 不显示本机地址', () => {
  assert.equal(comfyBaseUrl({ comfyui: { provider: 'native', baseUrl: 'http://127.0.0.1:8188' } }), 'http://127.0.0.1:8188');
  assert.equal(comfyBaseUrl({ comfyui: { provider: 'runninghub', apiKey: 'abc123', tier: 'standard' } }), 'https://www.runninghub.cn');
  assert.equal(comfyBaseUrl({ comfyui: { provider: 'runninghub', apiKey: 'abc123', tier: 'plus' } }), 'https://www.runninghub.cn');
  assert.equal(comfyBaseUrl({ comfyui: { provider: 'runninghub', apiKey: '', tier: 'standard' } }), 'https://www.runninghub.cn');
  assert.equal(comfyBaseUrl(null), 'http://127.0.0.1:8188');
  // api 模式下 baseUrl 里残留的是本机地址，展示出来会让人误以为还在连本机显卡
  const apiShown = comfyBaseUrl({ comfyui: { provider: 'api', baseUrl: 'http://127.0.0.1:8188' } });
  assert.ok(!apiShown.includes('8188'), '云端模式不该显示本机端口，实际：' + apiShown);
  assert.match(apiShown, /云端/);
  assert.ok(!maskComfyBaseUrl({ comfyui: { provider: 'api', baseUrl: 'http://127.0.0.1:8188' } }).includes('8188'));
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

// —— 云端商业 API 适配层（OpenAI 兼容生图/视频 + 小米 MiMo 配音）——
const {
  isCloudApi, cloudGenerate, cloudCheck, cloudLocalRef, cloudDownload, listModels,
  outItem, abortedError, readMediaBase64, saveTempMedia, tolerantPick,
  sizeForImageApi, withRetry,
} = await import('../lib/core/cloud-api.js');
const { sizeForVideoApi } = await import('../lib/core/cloud-video.js');

// 假密钥 + fetch mock，绝不打真实网络（那是用户掏钱的接口）
const imgCfg = () => ({ mediaApi: { image: { baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'gpt-image-2.5' } } });
const vidCfg = () => ({ mediaApi: { video: { baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'grok-imagine-video-1.5-fast' } } });
const ttsCfg = (over = {}) => ({
  mediaApi: { tts: { baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'mimo-v2.5-tts-voicedesign', voiceId: '', ...over } },
});
const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
const bufRes = (b, status = 200) => ({
  ok: status < 400,
  status,
  arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
  text: async () => b.toString('utf8'),
});

// 换上假 fetch，把每次调用的 url/init 记下来；返回 restore()
function mockFetch(handler) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const rec = { url: String(url), init, method: init.method || 'GET', headers: init.headers || {} };
    if (typeof init.body === 'string') rec.body = JSON.parse(init.body);
    else rec.body = init.body;
    calls.push(rec);
    return await handler(rec, calls.length - 1);
  };
  return { calls, restore: () => { global.fetch = orig; } };
}

test('isCloudApi: 仅 provider=api 走云端适配层', () => {
  assert.equal(isCloudApi({ comfyui: { provider: 'api' } }), true);
  assert.equal(isCloudApi({ comfyui: { provider: 'native' } }), false);
  assert.equal(isCloudApi({ comfyui: { provider: 'runninghub' } }), false);
  assert.equal(isCloudApi({}), false);
  assert.equal(isCloudApi(undefined), false);
});

test('sizeForImageApi: 宽高比就近归档到 gpt-image 三档，非法尺寸回落 1:1', () => {
  assert.equal(sizeForImageApi(1920, 1080), '1536x1024');
  assert.equal(sizeForImageApi(1080, 1920), '1024x1536');
  assert.equal(sizeForImageApi(1024, 1024), '1024x1024');
  assert.equal(sizeForImageApi(0, 1080), '1024x1024');
  assert.equal(sizeForImageApi(-100, 200), '1024x1024');
  assert.equal(sizeForImageApi(NaN, NaN), '1024x1024');
});

test('sizeForVideoApi: 显式宽高优先于 aspect_ratio，480P 只在 480 档里挑，非法回落 1280x720', () => {
  assert.equal(sizeForVideoApi(1920, 1080, '', ''), '1280x720');
  assert.equal(sizeForVideoApi(1080, 1920, '', ''), '720x1280');
  assert.equal(sizeForVideoApi(1024, 1024, '', ''), '1024x1024');
  assert.equal(sizeForVideoApi(0, 0, '', '9:16'), '720x1280', '没给宽高时按 aspect_ratio');
  assert.equal(sizeForVideoApi(0, 0, '480p', '16:9'), '854x480', '480P 档不能挑出 720P');
  assert.equal(sizeForVideoApi(0, 0, '480P', '9:16'), '480x854');
  assert.equal(sizeForVideoApi(0, 0, '', ''), '1280x720', '什么线索都没有按默认横屏');
  assert.equal(sizeForVideoApi(NaN, NaN, '', '乱七八糟'), '1280x720');
});

test('tolerantPick: 点号路径按序找第一个非空值，空串/null 跳过，找不到返回 undefined', () => {
  assert.equal(tolerantPick({ a: { b: 'v' } }, ['x.y', 'a.b']), 'v');
  assert.equal(tolerantPick({ a: [{ c: 1 }] }, ['a.0.c']), 1, '数字段当数组下标');
  assert.equal(tolerantPick({ a: '', b: 'fallback' }, ['a', 'b']), 'fallback', '空串算没命中');
  assert.equal(tolerantPick({ a: { b: null } }, ['a.b']), undefined);
  assert.equal(tolerantPick(null, ['a']), undefined);
  assert.equal(tolerantPick({ a: 0 }, ['a']), 0, '数字 0 是有效值，不能被当空跳过');
});

test('outItem: 产物项结构精确固定（subfolder 空串 / type=output）', () => {
  assert.deepEqual(
    outItem({ filename: 'a.png', kind: 'images', fileUrl: 'https://x.test/a.png' }),
    { filename: 'a.png', subfolder: '', type: 'output', kind: 'images', fileUrl: 'https://x.test/a.png' },
  );
});

test('abortedError: 带 interrupted 标记，供调用方区分「中止」与「失败」', () => {
  const e = abortedError();
  assert.ok(e instanceof Error);
  assert.equal(e.interrupted, true);
});

test('withRetry: 401/403 鉴权失败不重试（重试也没用，白扣钱）', async () => {
  let n = 0;
  const fail401 = async () => { n++; const e = new Error('nope'); e.status = 401; throw e; };
  await assert.rejects(withRetry(fail401, { times: 3 }), /nope/);
  assert.equal(n, 1, '401 只该试一次');
  let m = 0;
  await assert.rejects(withRetry(async () => { m++; throw new Error('boom'); }, { times: 1 }), /boom/);
  assert.equal(m, 1, 'times=1 不该有第二次');
});

test('readMediaBase64: base64/dataUri/mime/bytes 与文件一致；文件不存在抛错并带路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic_cloud_'));
  try {
    const p = path.join(dir, 'a.png');
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 1, 2, 3]);
    fs.writeFileSync(p, raw);
    const m = readMediaBase64(p);
    assert.equal(m.base64, raw.toString('base64'));
    assert.ok(m.dataUri.startsWith('data:image/png;base64,'), 'dataUri 前缀应带 png mime，实际：' + m.dataUri.slice(0, 40));
    assert.equal(m.mime, 'image/png');
    assert.equal(m.bytes, raw.length);
    const missing = path.join(dir, 'nope.png');
    assert.throws(() => readMediaBase64(missing), (e) => e.message.includes(missing), '报错信息应带缺失路径');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveTempMedia + cloudDownload: file:// 产物按字节取回（b64 图/配音没有远程 URL）', async () => {
  const raw = Buffer.from([0x49, 0x44, 0x33, 0x04, 1, 2, 3]);
  const url = saveTempMedia(raw, '.mp3');
  assert.ok(url.startsWith('file://'), '应返回 file:// URL，实际：' + url);
  assert.ok(url.endsWith('.mp3'));
  assert.deepEqual(await cloudDownload(url), raw);
});

test('cloudDownload: 云端把错误 JSON 当文件返回时必须报错，不能落成坏产物', async () => {
  const url = saveTempMedia(Buffer.from('{"error":"余额不足"}', 'utf8'), '.mp4');
  await assert.rejects(cloudDownload(url), /非文件内容/);
});

test('cloudGenerate(t2i): POST /images/generations，body 用配置里的 model，t2i 不带 image 字段', async () => {
  const m = mockFetch(async () => jsonRes({ id: 'img_1', data: [{ url: 'https://img.test/a.png' }] }));
  try {
    const submitted = [];
    const r = await cloudGenerate(imgCfg(), { kind: 't2i' },
      { positive_prompt: '一只猫', width: 1920, height: 1080 },
      { onSubmitted: (id) => submitted.push(id) });
    assert.equal(m.calls.length, 1, '同步返回图片时不该轮询');
    assert.equal(m.calls[0].url, 'https://x.test/v1/images/generations');
    assert.equal(m.calls[0].method, 'POST');
    assert.equal(m.calls[0].headers.Authorization, 'Bearer k');
    assert.equal(m.calls[0].body.model, 'gpt-image-2.5', 'model 必须来自配置');
    assert.equal(m.calls[0].body.prompt, '一只猫');
    assert.equal(m.calls[0].body.n, 1);
    assert.equal(m.calls[0].body.size, '1536x1024');
    assert.ok(!('image' in m.calls[0].body), 't2i 不应带参考图 image 字段');
    assert.equal(r.prompt_id, 'img_1');
    assert.equal(r.outputs[0].kind, 'images');
    assert.equal(r.outputs[0].filename, 'img_1.png');
    assert.equal(r.outputs[0].fileUrl, 'https://img.test/a.png');
    assert.deepEqual(submitted, ['img_1'], 'onSubmitted 应以图片 id 调用');
  } finally { m.restore(); }
});

test('cloudGenerate(t2i): 只回 b64_json 时落临时 png，cloudDownload 取回字节一致', async () => {
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
  const m = mockFetch(async () => jsonRes({ data: [{ b64_json: raw.toString('base64') }] }));
  try {
    const r = await cloudGenerate(imgCfg(), { kind: 't2i' }, { positive_prompt: 'x', width: 1024, height: 1024 });
    assert.ok(r.outputs[0].fileUrl.startsWith('file://'), 'b64 应落本地临时文件，实际：' + r.outputs[0].fileUrl);
    assert.ok(r.outputs[0].fileUrl.endsWith('.png'));
    assert.deepEqual(await cloudDownload(r.outputs[0].fileUrl), raw);
  } finally { m.restore(); }
});

test('cloudGenerate(i2i): 先走 multipart /images/edits，参考图当文件传', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic_i2i_'));
  const raw = Buffer.from([1, 2, 3, 4, 5]);
  const img = path.join(dir, 'ref.png');
  fs.writeFileSync(img, raw);
  const m = mockFetch(async () => jsonRes({ id: 'img_9', data: [{ url: 'https://img.test/b.png' }] }));
  try {
    const r = await cloudGenerate(imgCfg(), { kind: 'i2i' },
      { positive_prompt: '把衣服换成红色', image: img, width: 1024, height: 1024 });
    assert.equal(m.calls.length, 1, 'edits 成功就不该退回 generations');
    assert.equal(m.calls[0].url, 'https://x.test/v1/images/edits');
    const form = m.calls[0].body;
    assert.ok(form instanceof FormData, 'edits 必须用 multipart 提交');
    assert.equal(form.get('model'), 'gpt-image-2.5');
    assert.equal(form.get('prompt'), '把衣服换成红色');
    assert.equal(form.get('n'), '1');
    assert.equal(form.get('size'), '1024x1024');
    const blob = form.get('image');
    assert.ok(blob instanceof Blob, '参考图应以 Blob 形式带上');
    assert.equal(Buffer.from(await blob.arrayBuffer()).length, raw.length);
    assert.equal(r.outputs[0].fileUrl, 'https://img.test/b.png');
  } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cloudGenerate(i2i): edits 不被支持（404）时退回 generations + data URI 参考图', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic_i2i_'));
  const img = path.join(dir, 'ref.png');
  fs.writeFileSync(img, Buffer.from([1, 2, 3]));
  const m = mockFetch(async (rec, i) => (i === 0
    ? jsonRes({ error: { message: 'not found' } }, 404)
    : jsonRes({ id: 'img_2', data: [{ url: 'https://img.test/c.png' }] })));
  try {
    const r = await cloudGenerate(imgCfg(), { kind: 'i2i' }, { positive_prompt: 'p', image: img, width: 1024, height: 1024 });
    assert.equal(m.calls.length, 2);
    assert.equal(m.calls[1].url, 'https://x.test/v1/images/generations');
    assert.equal(m.calls[1].body.image, readMediaBase64(img).dataUri, '退回路径要把参考图当 data URI 直传');
    assert.equal(r.outputs[0].fileUrl, 'https://img.test/c.png');
  } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cloudGenerate(i2i): 401 鉴权失败不退回（退回也是 401，白花一次请求）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic_i2i_'));
  const img = path.join(dir, 'ref.png');
  fs.writeFileSync(img, Buffer.from([1]));
  const m = mockFetch(async () => jsonRes({ error: { message: 'invalid key' } }, 401));
  try {
    await assert.rejects(
      cloudGenerate(imgCfg(), { kind: 'i2i' }, { positive_prompt: 'p', image: img }),
      /401/,
    );
    assert.equal(m.calls.length, 1, '401 只该请求一次');
  } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cloudGenerate(i2i): 没有参考图直接报错，不发请求', async () => {
  const m = mockFetch(async () => jsonRes({}));
  try {
    await assert.rejects(cloudGenerate(imgCfg(), { kind: 'i2i' }, { positive_prompt: 'p' }), /缺少参考图/);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('cloudGenerate(r2v): 创建→轮询→成片，prompt_id 为厂商任务 id，seconds 是字符串', async () => {
  const raw = Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);
  const m = mockFetch(async (rec, i) => {
    if (i === 0) return jsonRes({ id: 'v1' });
    if (rec.url === 'https://v.test/a.mp4') return bufRes(raw);
    return jsonRes({ status: 'completed', url: 'https://v.test/a.mp4' });
  });
  try {
    const submitted = [];
    const r = await cloudGenerate(vidCfg(), { kind: 'r2v' },
      { positive_prompt: '镜头推进', width: 1920, height: 1080 },
      { pollMs: 1, onSubmitted: (id) => submitted.push(id) });
    assert.equal(m.calls[0].url, 'https://x.test/v1/videos');
    assert.equal(m.calls[0].body.model, 'grok-imagine-video-1.5-fast');
    assert.equal(m.calls[0].body.prompt, '镜头推进');
    assert.strictEqual(m.calls[0].body.seconds, '6', '缺省 6 秒，且必须是字符串');
    assert.equal(m.calls[0].body.size, '1280x720');
    assert.ok(!('input_reference' in m.calls[0].body), '无参考图＝纯文生视频，不该带 input_reference');
    assert.equal(m.calls[1].url, 'https://x.test/v1/videos/v1');
    assert.equal(r.prompt_id, 'v1');
    assert.equal(r.outputs[0].kind, 'videos');
    assert.equal(r.outputs[0].filename, 'v1.mp4');
    assert.ok(r.outputs[0].fileUrl.startsWith('file://'), '直链成片也应落本地 file://');
    assert.deepEqual(await cloudDownload(r.outputs[0].fileUrl), raw);
    assert.deepEqual(submitted, ['v1']);
  } finally { m.restore(); }
});

test('cloudGenerate(r2v): seconds 夹到 4~15；只有第一张参考图能当 input_reference（接口限制）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic_r2v_'));
  const img1 = path.join(dir, 'a.png');
  const img2 = path.join(dir, 'b.png');
  fs.writeFileSync(img1, Buffer.from([1, 1, 1]));
  fs.writeFileSync(img2, Buffer.from([2, 2, 2]));
  const m = mockFetch(async (rec, i) => {
    if (i === 0) return jsonRes({ id: 'v2' });
    if (rec.url === 'https://v.test/b.mp4') return bufRes(Buffer.from([0, 0, 0, 1]));
    return jsonRes({ status: 'succeeded', url: 'https://v.test/b.mp4' });
  });
  try {
    await cloudGenerate(vidCfg(), { kind: 'r2v' }, {
      positive_prompt: 'x', seconds: 30, width: 1080, height: 1920,
      references: [
        { type: 'image', filename: img1 },
        { type: 'image', filename: img2 },
        { type: 'audio', filename: path.join(dir, 'voice.mp3') },
      ],
    }, { pollMs: 1 });
    const body = m.calls[0].body;
    assert.strictEqual(body.seconds, '15', '超出上限要夹到 15');
    assert.equal(body.size, '720x1280');
    assert.equal(body.input_reference, readMediaBase64(img1).dataUri, 'input_reference 应为第一张图的 data URI');
  } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cloudGenerate(r2v): 查询不给 URL 时走 /content 下载字节落临时 mp4，且带鉴权头', async () => {
  const raw = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const m = mockFetch(async (rec, i) => {
    if (i === 0) return jsonRes({ id: 'v3' });
    if (rec.url.endsWith('/content')) return bufRes(raw);
    return jsonRes({ status: 'success' });
  });
  try {
    const r = await cloudGenerate(vidCfg(), { kind: 'r2v' }, { positive_prompt: 'x' }, { pollMs: 1 });
    const dl = m.calls.find((c) => c.url === 'https://x.test/v1/videos/v3/content');
    assert.ok(dl, '应请求 /content');
    assert.equal(dl.headers.Authorization, 'Bearer k', '取成片必须带鉴权头，否则中转站回 401');
    assert.ok(r.outputs[0].fileUrl.startsWith('file://'), '成片应落本地临时文件，下游不再远程取');
    assert.deepEqual(await cloudDownload(r.outputs[0].fileUrl), raw);
  } finally { m.restore(); }
});

test('cloudGenerate(r2v): 查询直接给直链时也带鉴权取回落临时文件（直链可能也要密钥）', async () => {
  const raw = Buffer.from([0, 0, 1, 2, 3, 4]);
  const m = mockFetch(async (rec, i) => {
    if (i === 0) return jsonRes({ id: 'v6' });
    if (rec.url === 'https://cdn.test/v6.mp4') return bufRes(raw);
    return jsonRes({ status: 'completed', url: 'https://cdn.test/v6.mp4' });
  });
  try {
    const r = await cloudGenerate(vidCfg(), { kind: 'r2v' }, { positive_prompt: 'x' }, { pollMs: 1 });
    const dl = m.calls.find((c) => c.url === 'https://cdn.test/v6.mp4');
    assert.ok(dl, '应下载查询响应给的直链');
    assert.equal(dl.headers.Authorization, 'Bearer k', '直链下载也要带鉴权头');
    assert.ok(r.outputs[0].fileUrl.startsWith('file://'), '直链也应转成本地 file://，避免下游无鉴权下载');
    assert.deepEqual(await cloudDownload(r.outputs[0].fileUrl), raw);
  } finally { m.restore(); }
});

test('cloudGenerate(r2v): 任务 failed 抛错并上报 error 状态', async () => {
  const m = mockFetch(async (rec, i) => (i === 0
    ? jsonRes({ id: 'v4' })
    : jsonRes({ status: 'failed', error: { message: '内容不合规' } })));
  try {
    const statuses = [];
    await assert.rejects(
      cloudGenerate(vidCfg(), { kind: 'r2v' }, { positive_prompt: 'x' }, { pollMs: 1, onStatus: (s) => statuses.push(s) }),
      /内容不合规/,
    );
    assert.ok(statuses.some((s) => s.kind === 'error'), '失败必须上报 error，前端才有话可显示');
  } finally { m.restore(); }
});

test('cloudGenerate(r2v): 用户停止 → interrupted 抛错，不算失败不上报 error', async () => {
  const m = mockFetch(async (rec, i) => jsonRes(i === 0 ? { id: 'v5' } : { status: 'in_progress' }));
  try {
    const statuses = [];
    const e = await cloudGenerate(vidCfg(), { kind: 'r2v' }, { positive_prompt: 'x' },
      { pollMs: 1, isAborted: () => true, onStatus: (s) => statuses.push(s) }).then(() => null, (err) => err);
    assert.ok(e, '应抛错');
    assert.equal(e.interrupted, true, '必须带 interrupted 标记，否则会被当成生成失败');
    assert.ok(!statuses.some((s) => s.kind === 'error'), '用户主动停止不该报 error');
  } finally { m.restore(); }
});

test('cloudGenerate(tts): user 放音色描述、assistant 放台词（小米约定，不能颠倒）', async () => {
  const raw = Buffer.from([0x49, 0x44, 0x33, 0x04, 5, 6]);
  const m = mockFetch(async () => jsonRes({
    id: 'tts_1',
    choices: [{ message: { audio: { data: raw.toString('base64') } } }],
  }));
  try {
    const r = await cloudGenerate(ttsCfg(), { kind: 'tts' },
      { text: '你终于来了。', voice_description: '低沉磁性的中年男声' });
    assert.equal(m.calls[0].url, 'https://x.test/v1/chat/completions');
    assert.equal(m.calls[0].headers['api-key'], 'k', '两种鉴权头都要发');
    assert.equal(m.calls[0].headers.Authorization, 'Bearer k');
    const body = m.calls[0].body;
    assert.equal(body.model, 'mimo-v2.5-tts-voicedesign');
    assert.deepEqual(body.messages, [
      { role: 'user', content: '低沉磁性的中年男声' },
      { role: 'assistant', content: '你终于来了。' },
    ]);
    assert.deepEqual(body.audio, { format: 'mp3' }, 'voicedesign 靠文字造音色，不能传预设 voice');
    assert.equal(r.prompt_id, 'tts_1');
    assert.equal(r.outputs[0].kind, 'audio');
    assert.equal(r.outputs[0].filename, 'tts_1.mp3');
    assert.ok(r.outputs[0].fileUrl.startsWith('file://'), '音频在响应体里，应落临时文件给 file://');
    assert.deepEqual(await cloudDownload(r.outputs[0].fileUrl), raw);
  } finally { m.restore(); }
});

test('cloudGenerate(tts): 预设音色模型才带 audio.voice；voicedesign 即便填了 voiceId 也不带', async () => {
  const audioB64 = Buffer.from([1, 2, 3]).toString('base64');
  const grab = async (cfg) => {
    const m = mockFetch(async () => jsonRes({ id: 't', choices: [{ message: { audio: { data: audioB64 } } }] }));
    try {
      await cloudGenerate(cfg, { kind: 'tts' }, { text: 'x', voice_description: 'y' });
      return m.calls[0].body.audio;
    } finally { m.restore(); }
  };
  assert.deepEqual(await grab(ttsCfg({ model: 'mimo-v2.5-tts', voiceId: 'voice_01' })),
    { format: 'mp3', voice: 'voice_01' }, '预设音色模型应带上 voiceId');
  assert.deepEqual(await grab(ttsCfg({ voiceId: 'voice_01' })),
    { format: 'mp3' }, 'voicedesign 传 voice 会冲突，必须省掉');
  assert.deepEqual(await grab(ttsCfg({ model: 'mimo-v2.5-tts', voiceId: '' })),
    { format: 'mp3' }, '没填 voiceId 就不带，让厂商用默认');
});

test('cloudGenerate(tts): 没给音色描述时用中性播音腔兜底，不能让台词跑到 user 里', async () => {
  const m = mockFetch(async () => jsonRes({ id: 't', choices: [{ message: { audio: { data: Buffer.from([1]).toString('base64') } } }] }));
  try {
    await cloudGenerate(ttsCfg(), { kind: 'tts' }, { text: '旁白台词' });
    const msgs = m.calls[0].body.messages;
    assert.match(msgs[0].content, /播音腔/, 'user 位应是兜底音色描述');
    assert.equal(msgs[1].content, '旁白台词');
  } finally { m.restore(); }
});

test('cloudGenerate(tts): 音频按十六进制返回时也能解（不能被 base64 误解成乱码）', async () => {
  const raw = Buffer.from([0x49, 0x44, 0x33, 0x04, 0xff, 0xfb]);
  const m = mockFetch(async () => jsonRes({ id: 'tts_h', choices: [{ message: { audio: { data: raw.toString('hex') } } }] }));
  try {
    const r = await cloudGenerate(ttsCfg(), { kind: 'tts' }, { text: 'x', voice_description: 'y' });
    assert.deepEqual(await cloudDownload(r.outputs[0].fileUrl), raw, 'hex 音频应还原成原字节');
  } finally { m.restore(); }
});

test('cloudGenerate(tts): HTTP 200 但业务报错仍算失败；找不到音频字段也算失败', async () => {
  const m1 = mockFetch(async () => jsonRes({ error: { message: '余额不足' } }));
  try {
    const statuses = [];
    await assert.rejects(
      cloudGenerate(ttsCfg(), { kind: 'tts' }, { text: 'x', voice_description: 'y' }, { onStatus: (s) => statuses.push(s) }),
      /余额不足/,
    );
    assert.ok(statuses.some((s) => s.kind === 'error'));
  } finally { m1.restore(); }

  const m2 = mockFetch(async () => jsonRes({ id: 't', choices: [{ message: { content: '只有文字没有音频' } }] }));
  try {
    await assert.rejects(cloudGenerate(ttsCfg(), { kind: 'tts' }, { text: 'x', voice_description: 'y' }), /找不到音频字段/);
  } finally { m2.restore(); }
});

test('cloudGenerate(tts): 用户停止 → 请求都不发，抛 interrupted', async () => {
  const m = mockFetch(async () => jsonRes({}));
  try {
    const e = await cloudGenerate(ttsCfg(), { kind: 'tts' }, { text: 'x' }, { isAborted: () => true })
      .then(() => null, (err) => err);
    assert.equal(e?.interrupted, true);
    assert.equal(m.calls.length, 0, '已停止就不该再花钱发请求');
  } finally { m.restore(); }
});

test('cloudGenerate: 未配置的任务类型直接报错，不静默返回空产物', async () => {
  await assert.rejects(cloudGenerate(imgCfg(), { kind: 'unknown_kind' }, {}), /不支持的云端任务类型/);
});

test('cloudCheck: 真去各档拉模型清单，任何一段连不上都不算连接成功', async () => {
  const full = {
    mediaApi: {
      image: { baseUrl: 'https://img.test/v1', apiKey: 'ik' },
      video: { baseUrl: 'https://vid.test/v1', apiKey: 'vk' },
      tts: { baseUrl: 'https://tts.test/v1', apiKey: 'tk' },
    },
  };
  const m = mockFetch(async (rec) => {
    if (rec.url.startsWith('https://vid.test')) return jsonRes({ error: 'bad key' }, 401);
    return jsonRes({ data: [{ id: 'a' }, { id: 'b' }] });
  });
  try {
    const r = await cloudCheck(full);
    assert.equal(r.ok, false, 'Key 被拒的那段还在，就不能报成功');
    assert.match(r.error, /1 段连不上/);
    const byId = Object.fromEntries(r.groups.map((g) => [g.id, g]));
    assert.equal(byId.image.state, 'ok');
    assert.equal(byId.image.text, '2 个模型');
    assert.equal(byId.video.state, 'fail');
    assert.match(byId.video.text, /Key 不对或被拒/, '厂商报错要翻成大白话');
    assert.equal(m.calls.length, 3, '三段各拉一次');
    assert.equal(m.calls[0].headers.Authorization, 'Bearer ik');
  } finally { m.restore(); }
});

test('cloudCheck: 三段都没填时提示去填，一个请求都不发', async () => {
  const m = mockFetch(async () => jsonRes({ data: [] }));
  try {
    const r = await cloudCheck({});
    assert.equal(r.ok, false);
    assert.match(r.error, /都没填/, '要说人话，用户才知道去哪儿填');
    assert.equal(m.calls.length, 0);
    const half = await cloudCheck({ mediaApi: { image: { baseUrl: 'https://img.test/v1', apiKey: 'ik' } } });
    assert.equal(half.ok, true, '只填了一段也算连上');
    assert.equal(half.groups.find((g) => g.id === 'video').text, '未填写');
  } finally { m.restore(); }
});

test('listModels: 各档取自己的 baseUrl/Key，data[] 与 models[] 两种返回形状都认', async () => {
  const m = mockFetch(async (rec) => (
    rec.url.startsWith('https://tts.test')
      ? jsonRes({ models: ['mimo-v2.6-pro', 'mimo-v2.5-tts'] })
      : jsonRes({ data: [{ id: 'gpt-image-2-1k' }, { id: 'gpt-image-2-4k' }] })
  ));
  try {
    const cfg = {
      mediaApi: {
        image: { baseUrl: 'https://img.test/v1/', apiKey: 'ik' },
        tts: { baseUrl: 'https://tts.test/v1', apiKey: 'tk' },
      },
    };
    assert.deepEqual(await listModels(cfg, 'image'), ['gpt-image-2-1k', 'gpt-image-2-4k']);
    assert.deepEqual(await listModels(cfg, 'tts'), ['mimo-v2.6-pro', 'mimo-v2.5-tts']);
    assert.equal(m.calls[0].url, 'https://img.test/v1/models', 'baseUrl 尾部斜杠要去重，别拼成 //models');
    await assert.rejects(listModels(cfg, 'video'), /还没填 Base URL/);
    await assert.rejects(listModels({ mediaApi: { image: { baseUrl: 'https://img.test/v1' } } }, 'image'), /还没填 API Key/);
  } finally { m.restore(); }
});

test('cloudLocalRef: api 模式不上传，原样返回本地绝对路径', () => {
  assert.equal(cloudLocalRef('/tmp/a.png'), '/tmp/a.png');
  const winPath = 'C:\\pics\\b.png';
  assert.equal(cloudLocalRef(winPath), winPath);
});


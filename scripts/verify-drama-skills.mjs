// 无 LLM 的确定性验证：确认短剧/漫剧技能（含新增两个技能包）可被发现与加载，
// 且 runTool 的 skill / skill_reference 工具能正确返回正文、嵌套参考文件全文与关键词路由。
import { listSkills, loadSkillWithResources, routeSkill } from '../lib/agent/skill-engine.js';
import { runTool, TOOL_DEFINITIONS } from '../lib/agent/tools.js';

const NEW = new Set([
  // 旧短剧/漫剧技能
  'manga-drama-generator', 'manga-full-stack', 'ai-manga-planner', 'manju-director-agent',
  'era-consistency-optimizer', 'script-master', 'novel-to-storyboard', 'novel-to-skitscreenplay',
  'comic-drama-generator', 'cinematic-ai-comic-director', 'hf-drama-storyboard-script',
  'micro-drama-creator', '0715-scriptwriter', 'script-to-manga',
  // 本次新增：短剧剧本 + 漫剧老李套装
  'short-drama-scriptwriting', 'short-drama-director',
  'sd-script-engine', 'sd-storyboard-engine', 'sd-asset-engine', 'sd-combat-engine',
  'sd-xuanhuan-engine', 'sd-real-engine', 'sd-feed-engine', 'sd-qc-engine',
  'sd-decision-engine', 'sd-jieshuo-engine', 'sd-overseas-engine', 'sd-recon-engine',
]);

const catalog = listSkills();
const found = catalog.filter((s) => NEW.has(s.name));
console.log('目录技能总数：' + catalog.length);
console.log('技能命中：' + found.length + ' / ' + NEW.size);
const missing = [...NEW].filter((n) => !catalog.some((s) => s.name === n));
if (missing.length) console.log('缺失：' + missing.join(', '));
const emptyDesc = found.filter((s) => !s.description);
console.log('描述为空的技能：' + (emptyDesc.length ? emptyDesc.map((s) => s.name).join(', ') : '无'));

// script-master 大技能
const sm = loadSkillWithResources('script-master');
console.log('script-master 正文长度：' + (sm.body || '').length + ' 字，参考文件数：' + (sm.references || []).length);

// 微短剧剧本技能
const shortScript = loadSkillWithResources('short-drama-scriptwriting');
console.log('short-drama-scriptwriting 正文长度：' + (shortScript?.body || '').length + ' 字');

// 总控技能 + 嵌套参考文件（references/style-bible/）
const director = loadSkillWithResources('short-drama-director');
const nested = (director?.references || []).find((r) => r.name === 'style-bible/style-lock-protocol.md');
console.log('short-drama-director 正文长度：' + (director?.body || '').length + ' 字，参考文件数：' + (director?.references || []).length);
console.log('嵌套参考 style-bible/style-lock-protocol.md：' + (nested ? '有' : '缺失'));

// 工具清单是否含 skill_reference
const toolNames = TOOL_DEFINITIONS.map((t) => t.function.name);
console.log('TOOL_DEFINITIONS 含 skill_reference：' + toolNames.includes('skill_reference'));

const ctx = {};
const skillOut = await runTool(ctx, 'skill', { name: 'script-master' });
console.log('--- skill(script-master) 前 400 字 ---');
console.log(skillOut.slice(0, 400));

const refOut = await runTool(ctx, 'skill_reference', { name: 'script-master', ref: 'framework.md' });
console.log('--- skill_reference(script-master, framework.md) 长度：' + refOut.length + '，前 300 字 ---');
console.log(refOut.slice(0, 300));

const nestedOut = await runTool(ctx, 'skill_reference', { name: 'short-drama-director', ref: 'style-bible/style-lock-protocol.md' });
console.log('--- skill_reference(short-drama-director, style-bible/style-lock-protocol.md) 长度：' + nestedOut.length + ' ---');

const badRef = await runTool(ctx, 'skill_reference', { name: 'script-master', ref: '不存在.md' }).catch((e) => 'ERROR: ' + e.message);
console.log('--- 加载不存在参考文件的报错 ---');
console.log(badRef);

// 关键词路由（新套装优先）
const routes = [
  ['漫剧老李全流程', 'short-drama-director'],
  ['台词诊断', 'sd-script-engine'],
  ['故事板分镜图', 'sd-storyboard-engine'],
  ['拆资产三清单', 'sd-asset-engine'],
  ['玄幻打斗法术对轰', 'sd-xuanhuan-engine'],
  ['真人打斗MMA', 'sd-real-engine'],
  ['投喂提示词包', 'sd-feed-engine'],
  ['质检连续性检查', 'sd-qc-engine'],
  ['对标爆款采风', 'sd-recon-engine'],
  ['微短剧分集剧本', 'short-drama-scriptwriting'],
];
let routeFail = 0;
for (const [q, want] of routes) {
  const got = routeSkill(q, '');
  if (got !== want) routeFail++;
  console.log((got === want ? 'OK' : 'FAIL') + ' routeSkill(' + q + ') = ' + got + '（期望 ' + want + '）');
}
console.log(routeFail ? '路由失败 ' + routeFail + ' 条' : '全部关键词路由通过');

// 任一硬性检查失败就让脚本以非 0 退出，便于 CI/人工验证直接判定
if (missing.length || emptyDesc.length || !shortScript?.body || !nested || routeFail) process.exitCode = 1;

// 无 LLM 的确定性验证：确认 14 个短剧/漫剧技能可被 listSkills/loadSkillWithResources 发现与加载，
// 且 runTool 的 skill / skill_reference 工具能正确返回正文与参考文件全文。
import { listSkills, loadSkillWithResources } from '../lib/agent/skill-engine.js';
import { runTool, TOOL_DEFINITIONS } from '../lib/agent/tools.js';

const NEW = new Set([
  'manga-drama-generator', 'manga-full-stack', 'ai-manga-planner', 'manju-director-agent',
  'era-consistency-optimizer', 'script-master', 'novel-to-storyboard', 'novel-to-skitscreenplay',
  'comic-drama-generator', 'cinematic-ai-comic-director', 'hf-drama-storyboard-script',
  'micro-drama-creator', '0715-scriptwriter', 'script-to-manga',
]);

const catalog = listSkills();
const found = catalog.filter((s) => NEW.has(s.name));
console.log('目录技能总数：' + catalog.length);
console.log('新技能命中：' + found.length + ' / 14');
const missing = [...NEW].filter((n) => !catalog.some((s) => s.name === n));
if (missing.length) console.log('缺失：' + missing.join(', '));
const emptyDesc = found.filter((s) => !s.description);
console.log('描述为空的新技能：' + (emptyDesc.length ? emptyDesc.map((s) => s.name).join(', ') : '无'));

// script-master 大技能
const sm = loadSkillWithResources('script-master');
console.log('script-master 正文长度：' + (sm.body || '').length + ' 字，参考文件数：' + (sm.references || []).length);
console.log('script-master 参考文件：' + (sm.references || []).map((r) => r.name + '(' + r.content.length + ')').join(', '));

// 工具清单是否含 skill_reference
const toolNames = TOOL_DEFINITIONS.map((t) => t.function.name);
console.log('TOOL_DEFINITIONS 含 skill_reference：' + toolNames.includes('skill_reference'));
console.log('工具总数：' + toolNames.length);

// runTool: skill 返回索引（不灌全部 references），skill_reference 返回单个全文
const ctx = {};
const skillOut = await runTool(ctx, 'skill', { name: 'script-master' });
console.log('--- skill(script-master) 前 400 字 ---');
console.log(skillOut.slice(0, 400));

const refOut = await runTool(ctx, 'skill_reference', { name: 'script-master', ref: 'framework.md' });
console.log('--- skill_reference(script-master, framework.md) 长度：' + refOut.length + '，前 300 字 ---');
console.log(refOut.slice(0, 300));

const badRef = await runTool(ctx, 'skill_reference', { name: 'script-master', ref: '不存在.md' }).catch((e) => 'ERROR: ' + e.message);
console.log('--- 加载不存在参考文件的报错 ---');
console.log(badRef);

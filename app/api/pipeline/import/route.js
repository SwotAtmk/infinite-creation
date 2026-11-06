// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
import { loadConfig, saveConfig } from '@/lib/core/index.js';
import { installSkillsFromZip, scanSkills, loadSkill } from '@/lib/agent/index.js';
import { PIPELINE_ZIP_MAX_BYTES, SKILL_PIPELINE_NODE_IDS } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

// 导入流水线技能编排包：zip 根层必须有 IC_CONFIG.json 作为格式标记。
export async function POST(req) {
  try {
    const limitMb = Math.round(PIPELINE_ZIP_MAX_BYTES / 1024 / 1024);
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > PIPELINE_ZIP_MAX_BYTES) {
      return NextResponse.json({ error: '流水线配置包过大：上限 ' + limitMb + 'MB' }, { status: 413 });
    }
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) return NextResponse.json({ error: '缺少 zip 文件内容' }, { status: 400 });
    if (buf.length > PIPELINE_ZIP_MAX_BYTES) {
      return NextResponse.json({ error: '流水线配置包过大：上限 ' + limitMb + 'MB' }, { status: 413 });
    }

    let zip;
    try {
      zip = new AdmZip(buf);
    } catch (e) {
      return NextResponse.json({ error: '无法解析 zip：' + e.message }, { status: 400 });
    }

    const configEntry = zip.getEntry('IC_CONFIG.json');
    if (!configEntry) {
      return NextResponse.json({ error: '不是有效的流水线配置包（缺少 IC_CONFIG.json）' }, { status: 400 });
    }

    let parsed;
    try {
      parsed = JSON.parse(configEntry.getData().toString('utf8'));
    } catch (e) {
      return NextResponse.json({ error: 'IC_CONFIG.json 解析失败：' + e.message }, { status: 400 });
    }

    const sp = parsed && parsed.skillPipeline ? parsed.skillPipeline : parsed;
    if (!sp || typeof sp !== 'object' || Array.isArray(sp)) {
      return NextResponse.json({ error: 'IC_CONFIG.json 缺少 skillPipeline 配置' }, { status: 400 });
    }
    if (!sp.nodes || typeof sp.nodes !== 'object' || Array.isArray(sp.nodes)) {
      return NextResponse.json({ error: 'skillPipeline.nodes 格式非法' }, { status: 400 });
    }
    for (const [k, v] of Object.entries(sp.nodes)) {
      if (v && v.skills !== undefined && !Array.isArray(v.skills)) {
        return NextResponse.json({ error: '节点 ' + k + ' 的 skills 必须是数组' }, { status: 400 });
      }
    }

    // 包里的技能目录会被整体安装（同名覆盖），因此「本机没有的技能」会随包一起导入。
    const installed = installSkillsFromZip(buf, { overwrite: true });
    scanSkills();

    // 引用校验：配置里点名、但本机（含刚装进来的）读不到的技能 —— 这些环节只能靠自动匹配兜底。
    const referenced = new Set();
    for (const v of Object.values(sp.nodes)) {
      if (!v || !Array.isArray(v.skills)) continue;
      for (const s of v.skills) {
        const name = String(s).trim();
        if (name) referenced.add(name);
      }
    }
    const missing = [...referenced].filter((name) => !loadSkill(name));
    const installedNames = new Set(installed.map((s) => s.name));
    const extra = [...installedNames].filter((name) => !referenced.has(name));
    const unknownNodes = Object.keys(sp.nodes).filter((id) => !SKILL_PIPELINE_NODE_IDS.includes(id));

    const cfg = loadConfig();
    cfg.skillPipeline = sp;
    saveConfig(cfg);

    return NextResponse.json({ ok: true, installed, skillPipeline: sp, missing, extra, unknownNodes });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

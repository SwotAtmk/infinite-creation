// 单个工作流的「结构」查看 / 编辑。
// GET 返回规格（语义角色映射）+ 原始节点 JSON，供 Studio 的流程页展示；
// PUT 只允许管理员（非 IC_PUBLIC）把修改后的节点 JSON 原子写回 workflows/ 下的源文件。
// WorkflowRunner 每次提交任务都会重新读取源文件，所以保存后对「下一次」生成立即生效；
// 正在 RunningHub 云端执行中的任务无法热改，需要取消后重新提交。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Workflows, WORKFLOWS_DIR, loadConfig, saveConfig, HW_PRESETS, hardwareMode } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

const PUBLIC_MODE = process.env.IC_PUBLIC === '1';
const MAX_BYTES = 8 * 1024 * 1024;


function safeSourcePath(sourceFile) {
  if (!sourceFile || typeof sourceFile !== 'string') throw new Error('缺少 sourceFile');
  const abs = path.resolve(WORKFLOWS_DIR, sourceFile);
  const rel = path.relative(WORKFLOWS_DIR, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('sourceFile 越界');
  if (!/\.json$/i.test(rel)) throw new Error('只允许编辑 .json 工作流文件');
  return abs;
}

function summarize(structure) {
  const nodes = Object.entries(structure || {}).map(([id, node]) => ({
    id,
    classType: node?.class_type || '',
    title: node?._meta?.title || '',
    inputs: Object.keys(node?.inputs || {}),
  }));
  return { nodeCount: nodes.length, nodes };
}

// 按行 id / spec.id 定位工作流记录（内置 DEFAULT_SPECS 与自定义工作流共用）。
function resolveWorkflow(id) {
  return Workflows.get(id) || Workflows.list().find((x) => x.spec?.id === id);
}

export async function GET(_req, { params }) {
  const { id } = await params;
  const w = resolveWorkflow(id);
  if (!w) return NextResponse.json({ error: '工作流不存在' }, { status: 404 });

  let abs;
  let structure = null;
  let sourceError = '';
  try {
    abs = safeSourcePath(w.sourceFile);
    structure = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    sourceError = e.message;
  }

  const cfg = loadConfig();
  return NextResponse.json({
    id: w.id,
    name: w.name,
    kind: w.kind,
    sourceFile: w.sourceFile,
    spec: w.spec,
    status: w.status,
    provider: cfg.comfyui?.provider || 'native',
    editable: !PUBLIC_MODE,
    sourceError,
    structure,
    summary: structure ? summarize(structure) : null,
  });
}

export async function PUT(req, { params }) {
  if (PUBLIC_MODE) return NextResponse.json({ error: '公开模式下不允许修改工作流' }, { status: 403 });
  const { id } = await params;
  const w = resolveWorkflow(id);
  if (!w) return NextResponse.json({ error: '工作流不存在' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  let structure = body?.structure;
  if (typeof body?.source === 'string') {
    try {
      structure = JSON.parse(body.source);
    } catch (e) {
      return NextResponse.json({ error: 'JSON 解析失败：' + e.message }, { status: 400 });
    }
  }
  if (!structure || typeof structure !== 'object' || Array.isArray(structure)) {
    return NextResponse.json({ error: 'structure 必须是工作流节点对象' }, { status: 400 });
  }
  const text = JSON.stringify(structure, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    return NextResponse.json({ error: '工作流文件超过 8MB 限制' }, { status: 413 });
  }

  try {
    const abs = safeSourcePath(w.sourceFile);
    const tmp = abs + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (e) {
    return NextResponse.json({ error: '保存失败：' + e.message }, { status: 500 });
  }

  // 可选：同时更新 DB 里的规格（roles/media/outputs），引导式编辑器保存节点映射用。
  let spec = w.spec;
  if (body?.spec && typeof body.spec === 'object') {
    spec = { ...(w.spec || {}), ...body.spec, id: w.spec?.id || id, sourceFile: w.sourceFile, name: w.name, kind: w.kind };
    Workflows.upsert({ name: w.name, kind: w.kind, sourceFile: w.sourceFile, spec, status: w.status });
  }

  return NextResponse.json({ ok: true, id: w.id, sourceFile: w.sourceFile, spec, summary: summarize(structure) });
}

// 删除自定义工作流（builtin=false 才允许）：删除源文件 + DB 行，并把指向它的 config.workflows 回落默认。
export async function DELETE(_req, { params }) {
  if (PUBLIC_MODE) return NextResponse.json({ error: '公开模式下不允许删除工作流' }, { status: 403 });
  const { id } = await params;
  const w = resolveWorkflow(id);
  if (!w) return NextResponse.json({ error: '工作流不存在' }, { status: 404 });
  if (w.spec?.builtin !== false) {
    return NextResponse.json({ error: '内置工作流不可删除，只能恢复默认' }, { status: 403 });
  }

  try {
    const abs = safeSourcePath(w.sourceFile);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch { /* 源文件缺失不影响删除记录 */ }
  Workflows.remove(w.id);

  // 若 config.workflows 仍指向被删的自定义工作流，回落到当前硬件模式预设，避免渲染时找不到规格。
  const cfg = loadConfig();
  const preset = HW_PRESETS[hardwareMode(cfg)] || {};
  const workflows = { ...(cfg.workflows || {}) };
  let changed = false;
  for (const [k, v] of Object.entries(workflows)) {
    if (v === w.spec?.id || v === w.id || v === w.name) {
      if (preset[k] !== undefined) workflows[k] = preset[k];
      else delete workflows[k];
      changed = true;
    }
  }
  if (changed) saveConfig({ ...cfg, workflows });

  return NextResponse.json({ ok: true, id: w.id });
}

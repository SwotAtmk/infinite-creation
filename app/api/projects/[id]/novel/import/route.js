// 生成视频：把小说（大纲 + 分卷 + 角色 + 章节正文）迁移成一个 type=agent 项目，进入小说→视频流水线
import { NextResponse } from 'next/server';
import { Projects, Chapters, Assets, withWriteContext, loadNovelState, buildImportDocument } from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function POST(_req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (p.type !== 'novel') return NextResponse.json({ error: '这不是小说项目' }, { status: 400 });

  const state = loadNovelState(id);
  // 按章节顺序（seq）迁移，只迁移已写正文的章节
  const chapters = Chapters.list(id).filter((c) => String(c.novel || '').trim());

  let newId;
  withWriteContext('POST /api/projects/:id/novel/import', () => {
    const newProj = Projects.create({
      name: p.name ? (p.name + '（视频版）') : '未命名小说（视频版）',
      type: 'agent',
      idea: String(p.idea || ''),
      auto_script: true,
      // 一次性按章节建好，避免先建「第1章」再追加造成空章节 / 重复章节
      chapters: chapters.map((c) => ({ title: c.title, novel: c.novel })),
    });
    newId = newProj.id;

    // 大纲描述：总纲 + 分卷卷纲 + 角色设定，写入项目 novel 字段，作为 Agent 的全书上下文
    const doc = buildImportDocument({
      name: p.name,
      idea: p.idea,
      structure: state.structure,
      characters: state.characters,
      volumes: state.volumes,
    });
    // 人物圣经：把角色设定写进 context.bible，作为后续剧本/分镜的一致性锚点
    const bible = state.characters
      .filter((c) => String(c.name || '').trim())
      .map((c) => `- ${c.name}（${c.role || '未标注'}）：${c.description || ''}`)
      .join('\n');
    const patch = { novel: doc };
    if (bible) patch.context = { ...(newProj.context || {}), bible };
    Projects.update(newId, patch);

    // 人物角色描述：迁移成素材库里的「角色」资产，Agent 出图/出视频时直接复用角色设定
    for (const c of state.characters) {
      const name = String(c.name || '').trim();
      const desc = String(c.description || '').trim();
      const role = String(c.role || '').trim();
      if (!name && !desc) continue;
      const description = [role ? '定位：' + role : '', desc].filter(Boolean).join('\n');
      Assets.create(newId, { category: 'character', name: name || '角色', description });
    }
  });

  return NextResponse.json({ id: newId, name: Projects.get(newId)?.name, chapters: chapters.length, characters: state.characters.length });
}

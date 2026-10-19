// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Assets, Projects, withWriteContext } from '@/lib/core/index.js';
import { ASSET_CATEGORY_IDS, isVariantAssetCategory } from '@/lib/shared/index.js';

export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const { id } = await params;
  const url = new URL(req.url);
  const category = url.searchParams.get('category') || null;
  return NextResponse.json(Assets.list(id, category));
}

export async function POST(req, { params }) {
  const { id } = await params;
  const { category = 'other', name, description = '', parent_id = '' } = await req.json().catch(() => ({}));
  if (!name) return NextResponse.json({ error: '缺少 name' }, { status: 400 });
  // 分类必须在值域内：素材库按 category 过滤（GET /assets?category=…、界面分组），
  // 写进一个不存在的分类就会造出「界面里看不见、批量生成也扫不到」的行（db 层还有一道）。
  if (!ASSET_CATEGORY_IDS.includes(category)) {
    return NextResponse.json({ error: '素材分类不存在：' + category + '（可选：' + ASSET_CATEGORY_IDS.join('/') + '）' }, { status: 400 });
  }
  // 同 chapters POST：先确认项目存在，避免写出挂在不存在项目下的孤儿素材行
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  // 服装/年龄是「挂在角色下的变体」：refs.js 只按 parent_id 映射到角色（镜头里有该角色时才拿它
  // 替换角色参考图），tools.js 也只把带 parent_id 的变体算作该角色已有服装/年龄。
  // 缺 parent_id 的变体在生成阶段被完全忽略，却照样出现在素材库与分镜引用列表里 ——
  // 用户以为绑上了、分镜也「更新成功」，实际静默无效（还会被自动换装再生成一套）。
  const parentId = String(parent_id || '').trim();
  if (isVariantAssetCategory(category)) {
    const parent = parentId ? Assets.get(parentId) : null;
    if (!parent || parent.project_id !== id) {
      return NextResponse.json({ error: '服装/年龄变体必须绑定到本项目的一个角色（parent_id）' }, { status: 400 });
    }
    if (parent.category !== 'character') {
      return NextResponse.json({ error: '服装/年龄变体的 parent_id 必须指向角色素材（当前是 ' + parent.category + '）' }, { status: 400 });
    }
  } else if (parentId) {
    // parent_id 的唯一语义是「挂在角色下的变体」（refs.js 只对 costume/age 按它映射角色）。
    // 写在其它分类上只会让 Assets.remove 把它当子变体级联删、usageOf 把它计成 children。
    return NextResponse.json({ error: 'parent_id 只用于服装（costume）/年龄（age）变体；' + category + ' 不能挂在其它素材下' }, { status: 400 });
  }
  return withWriteContext('POST /api/projects/:id/assets', async () => {
    try {
      return NextResponse.json(Assets.create(id, { category, name, description, parent_id: parentId }));
    } catch (e) {
      // 与 PATCH 同一套口径：db 层的分类/变体父守卫是入参错误，翻 400
      if (e && (e.code === 'BAD_ASSET_CATEGORY' || e.code === 'BAD_VARIANT_PARENT' || e.code === 'BAD_ASSET_PARENT')) return NextResponse.json({ error: e.message }, { status: 400 });
      throw e;
    }
  });
}

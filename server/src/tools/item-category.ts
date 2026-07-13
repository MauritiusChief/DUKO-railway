/**
 * lookupItemCategory 工具 —— 按 shapeTypeCode 查询 layout 物品分类与轨道
 *
 * 解决 layout agent / layout ocr agent 对 gaplike_item、stuffed_gap 等分类
 * 定义模糊、误判（如 WR 酒架被当成 stuffed_gap）的问题。
 *
 * LLM 在 insertItem / insertItemAtPosition 之前调用此工具，以查表结果作为
 * 分类、是否双轨、可用轨道的权威依据，避免凭语义猜测。
 *
 * 分类真源：constants.LAYOUT_CATEGORY_BY_SHAPE_TYPE（按分类分组）
 * 描述来源：exposed_types 表（getShapeTypeEntries，非硬编码）
 * 轨道逻辑：复用 layout.ts 的 targetTracks / isDualTrackCategory（共用单一逻辑）
 */

import type { ToolDefinition } from '../types/tool.js';
import type { BlockItemCategory } from '../types/layout.js';
import { LAYOUT_CATEGORY_BY_SHAPE_TYPE } from '../constants.js';
import { getShapeTypeEntries } from '../services/utils.js';
import { targetTracks, isDualTrackCategory } from './layout.js';

// 反向映射：shapeTypeCode(大写) -> BlockItemCategory
// 由分组常量 LAYOUT_CATEGORY_BY_SHAPE_TYPE 派生，保持单一真相源
const SHAPE_TYPE_TO_CATEGORY: ReadonlyMap<string, BlockItemCategory> = new Map(
  (Object.entries(LAYOUT_CATEGORY_BY_SHAPE_TYPE) as [BlockItemCategory, readonly string[]][]).flatMap(
    ([category, codes]) => codes.map((code) => [code.toUpperCase(), category]),
  ),
);

// 分类对应的中文含义，便于 LLM 理解返回结果（固定分类法标签，非产品数据）
const CATEGORY_MEANING: Readonly<Record<BlockItemCategory, string>> = {
  wall_cabinet: '吊柜',
  base_cabinet: '地柜',
  tall_cabinet: '通天高柜',
  gap: '空挡',
  stuffed_gap: '塞了东西的空挡',
  gaplike_item: '开放性商品（进清单但两侧不遮挡）',
  filler: '填充条',
  tall_appliance: '高电器',
  base_appliance_need_top: '需台面电器',
  base_appliance_without_top: '免台面电器',
};

/**
 * 从 exposed_types 表查询单个 shapeTypeCode 的描述（首次访问 DB，之后命中缓存）。
 * 找不到返回空串。
 */
function lookupDescription(upperCode: string): string {
  const entry = getShapeTypeEntries().find((e) => e.code.toUpperCase() === upperCode);
  return entry?.description ?? '';
}

export const LOOKUP_ITEM_CATEGORY_TOOL = {
  type: 'function',
  function: {
    name: 'lookupItemCategory',
    description:
      '按 shapeTypeCode 查询该形状对应的 layout 物品分类、是否双轨、可用轨道。' +
      '插入物品前调用此工具确认分类，避免凭语义猜测 gaplike_item / stuffed_gap 等。' +
      '入参为 2-4 字母的 shapeTypeCode（如 "WR"、"W"、"VAL"、"BF"），可从形状代码对照表或 SKU 前缀获取。',
    parameters: {
      type: 'object',
      properties: {
        shapeTypeCode: {
          type: 'string',
          description: '形状类型代码（如 "WR"、"W"、"B"、"VAL"、"BF"），大小写不敏感',
        },
      },
      required: ['shapeTypeCode'],
    },
  },
} as const satisfies ToolDefinition;

/**
 * 执行分类查询。
 * 命中：返回 `${code} -> ${category}（含义）| 双轨: 是/否 | 可用轨道: ... | 说明: ...`
 * 未命中：提示该 shapeType 多半是配件（不作布局块）或电器（按名称判断）。
 */
export function executeLookupItemCategory(args: Record<string, unknown>): string {
  const raw = String(args.shapeTypeCode ?? '').trim().toUpperCase();
  if (!raw) return '错误: shapeTypeCode 为必填项。';

  const category = SHAPE_TYPE_TO_CATEGORY.get(raw);
  if (!category) {
    return (
      `"${raw}" 不在 layout 物品分类表中。` +
      '该 shapeType 很可能是配件（molding/panel/post 等，不作为布局块、不进入 air/ground 轨道），' +
      '也可能是按名称判定的电器（refrigerator/dishwasher/range hood 等非 DUKO 产），' +
      '或是纯空位（gap / stuffed_gap 无对应 shapeTypeCode）。' +
      '若需确认具体 SKU，请使用 searchSkuShape。'
    );
  }

  const dual = isDualTrackCategory(category);
  const tracks = targetTracks(category);
  const meaning = CATEGORY_MEANING[category];
  const desc = lookupDescription(raw);

  return (
    `${raw} -> ${category}（${meaning}） | 双轨: ${dual ? '是' : '否'} | ` +
    `可用轨道: ${tracks.join(' + ')}${desc ? ` | 说明: ${desc}` : ''}`
  );
}

/**
 * lookupItemCategory 工具 —— 按 shapeTypeCode 查询 layout 物品分类与轨道
 *
 * 解决 layout agent / layout ocr agent 对 gaplike_item、stuffed_gap 等分类
 * 定义模糊、误判（如 WR 酒架被当成 stuffed_gap）的问题。
 *
 * LLM 在 insertItem / insertItemAtPosition 之前调用此工具，以查表结果作为
 * 分类、是否双轨、可用轨道的权威依据，避免凭语义猜测。
 *
 * 分类真源：constants.LAYOUT_CATEGORY_BY_SHAPE_TYPE
 * 轨道逻辑：复用 layout.ts 的 targetTracks / isDualTrackCategory（共用单一逻辑）
 */

import type { ToolDefinition } from '../types/tool.js';
import { LAYOUT_CATEGORY_BY_SHAPE_TYPE } from '../constants.js';
import { targetTracks, isDualTrackCategory } from './layout.js';

// 各 shapeTypeCode 的简短描述（用于工具返回，便于 LLM 校验理解）
// 与 dev_data/Exposed-Types.csv 对齐，仅收录已映射到 layout 分类的 code
const SHAPE_TYPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  // wall_cabinet
  W: 'Wall Cabinet（吊柜）',
  WBC: 'Wall Blind Corner（吊柜盲角）',
  WDC: 'Wall Diagonal Cabinet（吊柜对角柜）',
  WER: 'Wall Easy Reach / Corner（吊柜转角）',
  WMC: 'Wall Microwave Cabinet（吊柜微波炉柜）',
  // base_cabinet
  B: 'Base Cabinet（地柜）',
  BBC: 'Base Blind Corner（地柜盲角）',
  BLS: 'Base Lazy Susan（地柜小 Linda）',
  BMC: 'Base Microwave Cabinet（地柜微波炉柜）',
  BSR: 'Base Spice Rack Cabinet（地柜调料架柜）',
  CSB: 'Corner Sink Base（转角水槽柜）',
  NCSB: 'Corner Sink Base（转角水槽柜）',
  DB: 'Drawer Base（抽屉地柜）',
  FSB: 'Farm Sink Base（农家水槽柜）',
  SB: 'Sink Base（水槽柜）',
  VC: 'Vanity Combo（浴室组合柜）',
  VDB: 'Vanity Drawer Base（浴室抽屉柜）',
  VSB: 'Vanity Sink Base（浴室水槽柜）',
  VSD: 'Vanity Sink Base（浴室水槽柜）',
  VSDB: 'Vanity Sink Drawer Base（浴室水槽抽屉柜）',
  // tall_cabinet
  UT: 'Utility Pantry（通天高柜/储物柜）',
  OV: 'Oven Cabinet（烤箱高柜）',
  // filler
  BF: 'Base Filler（地柜填充条）',
  WF: 'Wall / Base Filler（吊/地柜填充条）',
  TF: 'Tall Filler（高柜填充条）',
  RF: 'Fridge Filler（冰箱填充条）',
  // gaplike_item
  VAL: 'Valance（挡板/装饰横条）',
  GH: 'Glass Holder / Glass Rack（玻璃杯架）',
  WES: 'Wall Ending Shelf（吊柜端架）',
  WR: 'Wine Rack（酒架）',
  BES: 'Base Ending Shelf（地柜端架）',
  PR: 'Plate Rack（碗碟架）',
};

// 分类对应的中文含义，便于 LLM 理解返回结果
const CATEGORY_MEANING: Readonly<Record<string, string>> = {
  wall_cabinet: '吊柜',
  base_cabinet: '地柜',
  tall_cabinet: '通天高柜',
  filler: '填充条',
  gaplike_item: '开放性商品（进清单但两侧不遮挡）',
};

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

  const category = LAYOUT_CATEGORY_BY_SHAPE_TYPE[raw];
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
  const meaning = CATEGORY_MEANING[category] ?? '';
  const desc = SHAPE_TYPE_DESCRIPTIONS[raw] ?? '';

  return (
    `${raw} -> ${category}（${meaning}） | 双轨: ${dual ? '是' : '否'} | ` +
    `可用轨道: ${tracks.join(' + ')}${desc ? ` | 说明: ${desc}` : ''}`
  );
}

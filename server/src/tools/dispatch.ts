/**
 * Dispatch 工具定义 —— TableParseAgent 向子 agent 委派工作的桥梁工具
 *
 * 三个 dispatch 工具均由 TableParseAgent 注册。LLM 决定何时调用、如何分批。
 * 实际执行逻辑在 TableParseAgent.executeTool() 中（创建子 agent 实例并运行），
 * 此文件仅定义 JSON schema。
 *
 * 工具列表：
 *  - dispatchBatchSearch    批量查 SKU（每批 ≤10 条）
 *  - dispatchPreciseSearch  单条深度查询
 *  - dispatchGlassDoorCalc  普通橱柜 → 玻璃门切割总数
 *  - dispatchLayoutOcr      委派 LayoutOcrAgent 对原图进行 OCR 复查
 */

import type { ToolDefinition } from '../types/tool.js';

// ==================================================================
//  dispatchBatchSearch
// ==================================================================

export const DISPATCH_BATCH_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'dispatchBatchSearch',
    description:
      '将一批物品委派给 BatchSearchAgent 进行批量数据库搜索。每批最多 10 项。' +
      '对每项分别用 searchSkuShape（编辑距离匹配形状）、searchSkuDescription（BM25 匹配描述）、' +
      'searchSkuOverlap（取交集）检索数据库。返回每项的最佳匹配产品代码。' +
      '适用场景：清单中大部分常规橱柜/配件，信息比较明确，批量搜索效率更高。',
    parameters: {
      type: 'object',
      properties: {
        batch: {
          type: 'array',
          description:
            '待批量搜索的物品列表。每项至少提供 identifier（原始名称或已知代码），' +
            'hint 字段为可选提示帮助缩小搜索范围。上限 10 项。',
          items: {
            type: 'object',
            properties: {
              identifier: {
                type: 'string',
                description: '原始名称、已知产品代码或简短描述',
              },
              colorCodeHint: {
                type: 'string',
                description: '颜色代码提示（如 "02"、"14"）。可选。',
              },
              shapeTypeCodeHint: {
                type: 'string',
                description: '形状型号代码提示（如 "B"、"W"、"GD"）。可选。',
              },
              shapeSizeCodeHint: {
                type: 'string',
                description: '尺寸代码提示（如 "15"、"18"）。可选。',
              },
              descriptionHint: {
                type: 'string',
                description: '自然语言描述提示（如 "corner cabinet"、"filler"）。可选。',
              },
            },
            required: ['identifier'],
          },
        },
      },
      required: ['batch'],
    },
  },
} as const satisfies ToolDefinition;

// ==================================================================
//  dispatchPreciseSearch
// ==================================================================

export const DISPATCH_PRECISE_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'dispatchPreciseSearch',
    description:
      '将单条物品委派给 PreciseSearchAgent 进行深度精确查询。' +
      '子 agent 使用 searchSkuStructured 工具（支持编辑距离模糊形状匹配 + BM25 描述搜索 + 向量语义检索），' +
      '通过 JSON 过滤树的并/交/补集操作做细粒度多维度检索。' +
      '适用场景：信息模糊、需要多重条件组合过滤、或批量搜索无法确认的单条物品。' +
      '每次调用只处理 1 条物品。',
    parameters: {
      type: 'object',
      properties: {
        item: {
          type: 'object',
          properties: {
            originalName: {
              type: 'string',
              description: '物品的原始名称或已知产品代码',
            },
            searchGuidance: {
              type: 'string',
              description:
                '自然语言查询指导（如 "用户说可能是 30W18 但不确定颜色和尺寸，请在 W 型中搜索 18 寸左右的"）。',
            },
          },
          required: ['originalName'],
        },
      },
      required: ['item'],
    },
  },
} as const satisfies ToolDefinition;

// ==================================================================
//  dispatchGlassDoorCalc
// ==================================================================

export const DISPATCH_GLASS_DOOR_CALC_TOOL = {
  type: 'function',
  function: {
    name: 'dispatchGlassDoorCalc',
    description:
      '将一组普通橱柜型号委派给 GlassDoorAgent 计算所需的定制玻璃门总数。' +
      '子 agent 会在数据库中查找每个橱柜型号的 otherDescription 字段，' +
      '通过 LLM 自然语言理解提取每个型号的门数，然后乘以数量汇总出总门数。' +
      '适用场景：用户清单中有需要额外定制玻璃门的橱柜（这些橱柜本身不包含玻璃门）。',
    parameters: {
      type: 'object',
      properties: {
        cabinetModels: {
          type: 'array',
          description: '需要计算门数的普通橱柜型号列表（非玻璃门型号）',
          items: {
            type: 'object',
            properties: {
              shapeTypeCode: {
                type: 'string',
                description: '形状型号代码（如 "B"、"W"、"SB"）。必填。',
              },
              shapeSizeCode: {
                type: 'string',
                description: '尺寸代码（如 "15"、"18"）。可选，不填则匹配该类型的所有尺寸。',
              },
              colorCodeHint: {
                type: 'string',
                description: '颜色代码提示（如 "02"）。可选，用于缩小搜索范围。',
              },
              quantity: {
                type: 'number',
                description: '该型号的数量。默认为 1。',
              },
            },
            required: ['shapeTypeCode'],
          },
        },
      },
      required: ['cabinetModels'],
    },
  },
} as const satisfies ToolDefinition;

// ==================================================================
//  dispatchLayoutOcr
// ==================================================================

export const DISPATCH_LAYOUT_OCR_TOOL = {
  type: 'function',
  function: {
    name: 'dispatchLayoutOcr',
    description:
      '当发现初始 OCR 可能漏识别、局部文字不清、宽度冲突、双轨物体无法对齐时，' +
      '调用此工具要求 OCR agent 带备注重新检查原图特定区域。',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '给 OCR agent 的复查说明（如 "请重新检查左起第三段区域，似乎有遗漏的吊柜"）',
        },
        targetArea: {
          type: 'string',
          description: '图片区域描述，如 left/right/top/bottom/center 或自然语言区域',
        },
        expectedIssue: {
          type: 'string',
          description: '怀疑的问题，如 missing item、unclear width、dual-track alignment mismatch',
        },
      },
      required: ['note'],
    },
  },
} as const satisfies ToolDefinition;

/**
 * 清单编辑工具 —— 客户清单（items）的读写操作
 *
 * 提供以下 function calling 工具：
 *  - readParsedItems  读取当前清单
 *  - addItem          插入新行
 *  - deleteItem       删除指定行
 *  - editItemCell     编辑单元格
 *
 * 所有编辑工具不受搜索预算约束。
 * 同一轮多工具调用时使用快照索引解析避免偏移。
 */

import { markdownTable } from 'markdown-table';
import type { ToolDefinition } from '../types/tool.js';
import type { MutableManifest } from '../types/manifest.js';

// ==================================================================
//  类型（与 tools.ts 中的 ParsedItem 结构一致）
// ==================================================================

interface ParsedField {
  values: string[];
}

interface ParsedItem {
  originalName: string;
  color: ParsedField;
  shapeType: ParsedField;
  shapeSize: ParsedField;
  quantity: number;
  /** 定制要求：undefined=不限制(取全部零件), "door"=仅柜门, "box"=仅柜体 */
  customRequirement?: 'door' | 'box';
  /** 在 Exposed-Items 数据库中的匹配状态 */
  status: 'found' | 'missing';
  /** 该型号无颜色概念，检索和生成产品时忽略颜色字段 */
  colorIgnored?: boolean;
  /** 该型号无尺寸概念，检索和生成产品时忽略尺寸字段 */
  shapeSizeIgnored?: boolean;
}

export type { ParsedItem, ParsedField };

// ==================================================================
//  快照索引解析
// ==================================================================

/**
 * 将 LLM 基于快照的行序号（1-based）解析为当前数组中的 0-based 索引。
 * 若快照中的对象仍在当前数组中（引用相等），返回其当前位置；
 * 若已不在（被前置删除操作移除），返回 -1。
 */
export function resolveIndexFromSnapshot<T>(
  snapshot: T[] | undefined,
  current: T[],
  rowIndex: number,
): number {
  if (!snapshot || snapshot.length === 0) {
    return rowIndex - 1;
  }
  const snapshotIdx = rowIndex - 1;
  if (snapshotIdx < 0 || snapshotIdx >= snapshot.length) {
    return rowIndex - 1;
  }
  const target = snapshot[snapshotIdx];
  if (!target) {
    return rowIndex - 1;
  }
  return current.indexOf(target);
}

// ==================================================================
//  readParsedItems
// ==================================================================

export const READ_PARSED_ITEMS_TOOL = {
  type: 'function',
  function: {
    name: 'readParsedItems',
    description:
      '读取当前已解析的客户清单表格。返回带序号（# 列）和所有字段的 Markdown 表格，序号供后续编辑工具（addItem / deleteItem / editItemCell）引用。当用户要求查看、核对或列出当前清单时调用此工具。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
} as const satisfies ToolDefinition;

export function executeReadParsedItems(state: MutableManifest): string {
  const { items } = state;

  if (!items || items.length === 0) {
    return '## 当前清单\n\n**暂无已解析的清单数据。** 请先通过首页解析客户清单后再进行对话，或使用 addItem 工具添加项目。';
  }

  const header = ['#', '原始名称', '颜色代码', '形状型号', '形状尺寸', '定制要求', '数量'];
  const rows: string[][] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as ParsedItem;
    // 多候选值用 " / " 连接展示，例如 "02 / 03 / 14"
    const colorText = item.color?.values?.length
      ? item.color.values.join(' / ')
      : '-';
    const shapeTypeText = item.shapeType?.values?.length
      ? item.shapeType.values.join(' / ')
      : '-';
    const shapeSizeText = item.shapeSize?.values?.length
      ? item.shapeSize.values.join(' / ')
      : '-';
    const reqText = item.customRequirement || '-';
    rows.push([
      String(i + 1),
      item.originalName || '-',
      colorText,
      shapeTypeText,
      shapeSizeText,
      reqText,
      String(item.quantity ?? 1),
    ]);
  }

  const table = markdownTable([header, ...rows]);

  return `## 当前清单（共 ${items.length} 项）

${table}

> 使用 **序号**（第 1 列 \`#\`）作为 \`rowIndex\` 参数调用编辑工具。`;
}

// ==================================================================
//  addItem
// ==================================================================

export const ADD_ITEM_TOOL = {
  type: 'function',
  function: {
    name: 'addItem',
    description:
      '向客户清单中插入新的一行。若指定 rowIndex，则插入到该位置（原行及之后行顺延）；若不指定，则添加到清单末尾。' +
      '颜色代码、形状型号、形状尺寸可传入单个字符串，也可传入字符串数组表示多个候选值（前端会以 radio buttons 展示供用户选择）。' +
      'customRequirement 可选，用于标记该物品生成产品时：不填=取全部零件, "door"=仅取柜门零件, "box"=仅取柜体零件(不含额外件)。',
    parameters: {
      type: 'object',
      properties: {
        rowIndex: {
          type: 'number',
          description: '插入位置（1-based 序号，与 readParsedItems 返回的 # 列对应）。不填则追加到末尾。',
        },
        originalName: {
          type: 'string',
          description: '原始名称/描述（必填）',
        },
        colorCode: {
          type: 'string',
          description:
            '颜色代码。可传入单个值如 "02"，或传入逗号分隔的多个候选值如 "02, 03, 14"（前端会显示为多选 radio）。' +
            '当搜索结果有多个候选颜色时，应列出全部候选而非仅首选。不确定可留空。',
        },
        shapeTypeCode: {
          type: 'string',
          description:
            '形状型号代码。可传入单个值如 "B"，或传入逗号分隔的多个候选值如 "B, W, SB"（前端会显示为多选 radio）。' +
            '当搜索结果有多个候选形状时，应列出全部候选而非仅首选。不确定可留空。',
        },
        shapeSizeCode: {
          type: 'string',
          description:
            '尺寸代码。可传入单个值如 "15"，或传入逗号分隔的多个候选值如 "15, 18, 21"（前端会显示为多选 radio）。' +
            '当搜索结果有多个候选尺寸时，应列出全部候选而非仅首选。不确定可留空。',
        },
        quantity: {
          type: 'number',
          description: '数量（可选，默认为 1）',
        },
        customRequirement: {
          type: 'string',
          description: '定制要求（可选）。"door"=仅柜门, "box"=仅柜体。不填则取全部零件。',
          enum: ['door', 'box'],
        },
      },
      required: ['originalName'],
    },
  },
} as const satisfies ToolDefinition;

export function executeAddItem(state: MutableManifest, args: Record<string, unknown>): string {
  const originalName = String(args.originalName ?? '');
  if (!originalName.trim()) {
    return '## addItem 结果\n\n**错误**: `originalName` 为必填项，请提供物品名称。';
  }

  // 解析字段候选值：支持逗号/顿号分隔的单个字符串，也支持数组
  const parseFieldValues = (field: unknown): string[] => {
    if (Array.isArray(field)) {
      // LLM 传入数组时，提取所有非空字符串
      return field
        .map((v) => String(v ?? '').trim())
        .filter(Boolean);
    }
    if (typeof field === 'string' && field.trim()) {
      // LLM 传入逗号或顿号分隔的字符串时，拆分为多个候选值
      return field
        .split(/[,，、]/)
        .map((v) => v.trim())
        .filter(Boolean);
    }
    return [];
  };

  const colorValues = parseFieldValues(args.colorCode);
  const shapeTypeValues = parseFieldValues(args.shapeTypeCode);
  const shapeSizeValues = parseFieldValues(args.shapeSizeCode);
  const quantity = typeof args.quantity === 'number' && args.quantity > 0
    ? Math.round(args.quantity)
    : 1;

  const customReqVal = args.customRequirement;
  const customRequirement: 'door' | 'box' | undefined =
    customReqVal === 'door' || customReqVal === 'box' ? customReqVal : undefined;

  const newItem: ParsedItem = {
    originalName: originalName.trim(),
    color: { values: colorValues },
    shapeType: { values: shapeTypeValues },
    shapeSize: { values: shapeSizeValues },
    quantity,
    customRequirement,
    status: 'missing', // 新添加的项目默认未匹配，等待后续检查
  };

  let insertPos: number;
  if (typeof args.rowIndex === 'number' && args.rowIndex >= 1 && args.rowIndex <= state.items.length + 1) {
    insertPos = Math.floor(args.rowIndex) - 1;
  } else {
    insertPos = state.items.length;
  }

  state.items.splice(insertPos, 0, newItem);

  const positionLabel = insertPos < state.items.length - 1
    ? `第 ${insertPos + 1} 行`
    : '末尾';

  const formatValues = (vals: string[]): string =>
    vals.length > 0 ? vals.join(' / ') : '(未填)';

  return `## addItem 结果

已添加到清单${positionLabel}：
- **原始名称**: ${newItem.originalName}
- **颜色代码**: ${formatValues(newItem.color.values)}
- **形状型号**: ${formatValues(newItem.shapeType.values)}
- **形状尺寸**: ${formatValues(newItem.shapeSize.values)}
- **定制要求**: ${newItem.customRequirement || '-'}
- **数量**: ${newItem.quantity}

当前清单共 ${state.items.length} 项。`;
}

// ==================================================================
//  deleteItem
// ==================================================================

export const DELETE_ITEM_TOOL = {
  type: 'function',
  function: {
    name: 'deleteItem',
    description:
      '从客户清单中删除指定行。序号来自 readParsedItems 返回的 # 列。',
    parameters: {
      type: 'object',
      properties: {
        rowIndex: {
          type: 'number',
          description: '要删除的行序号（1-based，与 readParsedItems 返回的 # 列对应）',
        },
      },
      required: ['rowIndex'],
    },
  },
} as const satisfies ToolDefinition;

export function executeDeleteItem(state: MutableManifest, args: Record<string, unknown>): string {
  const rawRowIndex = typeof args.rowIndex === 'number' ? Math.floor(args.rowIndex) : -1;
  const resolvedIdx = resolveIndexFromSnapshot(state.itemSnapshot, state.items, rawRowIndex);

  if (resolvedIdx < 0 || resolvedIdx >= state.items.length) {
    return `## deleteItem 结果\n\n**错误**: 行序号 ${args.rowIndex} 无效。当前清单共 ${state.items.length} 项，有效范围 1–${state.items.length}。请先调用 readParsedItems 确认行号。`;
  }

  const removed = state.items[resolvedIdx] as ParsedItem;
  state.items.splice(resolvedIdx, 1);

  const fmtVals = (vals: string[]): string =>
    vals.length > 0 ? vals.join(' / ') : '(未填)';

  return `## deleteItem 结果

已从清单中删除第 ${resolvedIdx + 1} 行：
- **原始名称**: ${removed.originalName}
- **颜色代码**: ${fmtVals(removed.color.values)}
- **形状型号**: ${fmtVals(removed.shapeType.values)}
- **形状尺寸**: ${fmtVals(removed.shapeSize.values)}
- **定制要求**: ${removed.customRequirement || '-'}
- **数量**: ${removed.quantity}

当前清单共 ${state.items.length} 项。`;
}

// ==================================================================
//  editItemCell
// ==================================================================

export const EDIT_ITEM_CELL_TOOL = {
  type: 'function',
  function: {
    name: 'editItemCell',
    description:
      '编辑清单中指定行、指定列的值。序号来自 readParsedItems 返回的 # 列。可编辑的列为：color（颜色代码）、shapeType（形状型号）、shapeSize（形状尺寸）、customRequirement（定制要求："door"/"box"/""）、quantity（数量）。' +
      'value 可传入单个字符串，或传入逗号分隔的多个候选值（前端会以 radio buttons 展示）。',
    parameters: {
      type: 'object',
      properties: {
        rowIndex: {
          type: 'number',
          description: '要编辑的行序号（1-based，与 readParsedItems 返回的 # 列对应）',
        },
        column: {
          type: 'string',
          description: '要编辑的列名。可选值: "color"（颜色代码）, "shapeType"（形状型号）, "shapeSize"（形状尺寸）, "customRequirement"（定制要求）, "quantity"（数量）',
          enum: ['color', 'shapeType', 'shapeSize', 'customRequirement', 'quantity'],
        },
        value: {
          type: 'string',
          description:
            '新值。单个值如 "02" 或 "B" 或 "15"；' +
            '多个候选值时用逗号分隔如 "02, 03, 14"（前端会显示多选 radio 供用户选择）。' +
            '空字符串表示清空该字段。',
        },
      },
      required: ['rowIndex', 'column', 'value'],
    },
  },
} as const satisfies ToolDefinition;

export function executeEditItemCell(state: MutableManifest, args: Record<string, unknown>): string {
  const rawRowIndex = typeof args.rowIndex === 'number' ? Math.floor(args.rowIndex) : -1;
  const resolvedIdx = resolveIndexFromSnapshot(state.itemSnapshot, state.items, rawRowIndex);
  const column = String(args.column ?? '');
  const rawValue = args.value;

  if (resolvedIdx < 0 || resolvedIdx >= state.items.length) {
    return `## editItemCell 结果\n\n**错误**: 行序号 ${args.rowIndex} 无效。当前清单共 ${state.items.length} 项，有效范围 1–${state.items.length}。`;
  }

  if (!['color', 'shapeType', 'shapeSize', 'customRequirement', 'quantity'].includes(column)) {
    return `## editItemCell 结果\n\n**错误**: 列名 "${column}" 无效。有效列名: color, shapeType, shapeSize, customRequirement, quantity。`;
  }

  // 解析字段候选值：支持逗号/顿号分隔的字符串，也支持数组
  const parseFieldValues = (field: unknown): string[] => {
    if (Array.isArray(field)) {
      return field
        .map((v) => String(v ?? '').trim())
        .filter(Boolean);
    }
    if (typeof field === 'string' && field.trim()) {
      return field
        .split(/[,，、]/)
        .map((v) => v.trim())
        .filter(Boolean);
    }
    return [];
  };

  const item = state.items[resolvedIdx] as ParsedItem;
  const oldValue: string = (() => {
    if (column === 'color') return item.color.values.join(' / ') || '(未填)';
    if (column === 'shapeType') return item.shapeType.values.join(' / ') || '(未填)';
    if (column === 'shapeSize') return item.shapeSize.values.join(' / ') || '(未填)';
    if (column === 'customRequirement') return item.customRequirement || '-';
    return String(item.quantity);
  })();

  const newDisplayValue: string = (() => {
    if (column === 'quantity') {
      const qty = parseFloat(String(rawValue ?? ''));
      if (isNaN(qty) || qty <= 0) {
        return `**错误**: 数量值 "${String(rawValue)}" 无效，必须为正数。`;
      }
      item.quantity = Math.round(qty);
      return String(item.quantity);
    }

    if (column === 'customRequirement') {
      const val = String(rawValue ?? '').trim();
      if (val === 'door' || val === 'box') {
        item.customRequirement = val;
        return val;
      }
      // 空字符串或无效值 → 清除为 undefined
      item.customRequirement = undefined;
      return '(已清空，不限制)';
    }

    const values = parseFieldValues(rawValue);
    if (column === 'color') {
      item.color = { values };
    } else if (column === 'shapeType') {
      item.shapeType = { values };
    } else if (column === 'shapeSize') {
      item.shapeSize = { values };
    }
    return values.length > 0 ? values.join(' / ') : '(已清空)';
  })();

  // 如果数量校验失败，直接返回错误
  if (newDisplayValue.startsWith('**错误**')) {
    return `## editItemCell 结果\n\n${newDisplayValue}`;
  }

  return `## editItemCell 结果

已修改清单第 ${resolvedIdx + 1} 行（${item.originalName}）：
- **列**: ${column}
- **旧值**: ${oldValue}
- **新值**: ${newDisplayValue}`;
}

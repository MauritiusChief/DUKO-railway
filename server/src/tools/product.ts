/**
 * 产品工具 —— Exposed-Items 产品查询与生成后的产品清单编辑
 *
 * 提供以下 function calling 工具：
 *  - lookupProductInventory   Exposed-Items → Product 库存查询
 *  - lookupItemComponents     完整型号 → 组成 Product 解析
 *  - readGeneratedProducts    读取产品清单
 *
 * 所有工具不受搜索预算约束。
 */

import { markdownTable } from 'markdown-table';
import type { ToolDefinition } from '../types/tool.js';
import type { MutableManifest, ProductEntry } from '../types/manifest.js';
import { findRecordByItemNameCI } from '../db/sku.js';
import { getItemsMap, getPartsMap, getProductMap } from '../services/utils.js';

// ==================================================================
//  lookupProductInventory
// ==================================================================

export const LOOKUP_PRODUCT_INVENTORY_TOOL = {
  type: 'function',
  function: {
    name: 'lookupProductInventory',
    description:
      '通过 Exposed-Items 中的产品名称（itemName），查询其转化后的 DUKO 实际产品（Product）名称及库存信息（Forecasted Quantity / Free to use Quantity / Quantity On Hand）。适用于用户询问某个清单产品的库存情况、缺货判断等场景。',
    parameters: {
      type: 'object',
      properties: {
        itemName: {
          type: 'string',
          description: 'Exposed-Items 中的产品名称。例如 "02B15"、"02W3012"、"02BTCR15" 等。与 searchSku 结果中的 itemName 或清单中组合后的 itemName 对应。',
        },
      },
      required: ['itemName'],
    },
  },
} as const satisfies ToolDefinition;

export function executeLookupProductInventory(args: Record<string, unknown>): string {
  const itemName = String(args.itemName ?? '').trim();
  if (!itemName) {
    return '## lookupProductInventory 结果\n\n**错误**: `itemName` 为必填项。';
  }

  const itemsMap = getItemsMap();
  const partsMap = getPartsMap();
  const productMap = getProductMap();

  const exposedRecord = findRecordByItemNameCI(itemName);
  if (!exposedRecord) {
    return `## lookupProductInventory 结果\n\n**未找到**: Exposed-Items 中不存在产品 "${itemName}"。请核实名称是否正确。`;
  }

  const itemNamesToResolve: string[] = [];
  if (exposedRecord.subItemsName) {
    const subNames = exposedRecord.subItemsName.split(',').map((s) => s.trim()).filter(Boolean);
    itemNamesToResolve.push(...subNames);
  } else {
    itemNamesToResolve.push(itemName);
  }

  interface InventoryRow {
    exposedItem: string;
    productName: string;
    description: string;
    forecastedQty: number;
    freeToUseQty: number;
    qtyOnHand: number;
  }

  const rows: InventoryRow[] = [];
  const seenProductNames = new Set<string>();

  for (const resolveName of itemNamesToResolve) {
    const itemRow = itemsMap.get(resolveName);
    if (!itemRow) continue;

    const partNames = new Set<string>();
    if (itemRow.doorPart) partNames.add(itemRow.doorPart);
    if (itemRow.cabinetPart) partNames.add(itemRow.cabinetPart);
    if (itemRow.extraPart) partNames.add(itemRow.extraPart);

    for (const partName of partNames) {
      const partRow = partsMap.get(partName);
      const sharedPartName = partRow?.sharedPartName || partName;

      if (seenProductNames.has(sharedPartName)) continue;
      seenProductNames.add(sharedPartName);

      const productRow = productMap.get(sharedPartName);

      rows.push({
        exposedItem: resolveName,
        productName: sharedPartName,
        description: partRow?.description || '',
        forecastedQty: productRow?.forecastedQty ?? 0,
        freeToUseQty: productRow?.freeToUseQty ?? 0,
        qtyOnHand: productRow?.qtyOnHand ?? 0,
      });
    }
  }

  if (rows.length === 0) {
    return `## lookupProductInventory 结果

**"${itemName}"** 在 Exposed-Items 中存在（${exposedRecord.mainDescription || '无描述'}），但其对应的实际产品无法在 Items.csv / Parts.csv 中解析。可能是配件或特殊产品。`;
  }

  const header = ['#', 'Exposed Item', 'Product Name', 'Description', 'Forecasted Qty', 'Free to Use', 'Qty On Hand'];
  const tableRows: string[][] = rows.map((r, i) => [
    String(i + 1),
    r.exposedItem,
    r.productName,
    r.description || '-',
    String(r.forecastedQty),
    String(r.freeToUseQty),
    String(r.qtyOnHand),
  ]);

  const table = markdownTable([header, ...tableRows]);

  const hasSubItems = itemNamesToResolve.length > 1;

  return `## lookupProductInventory 结果

- **查询**: "${itemName}" → ${exposedRecord.mainDescription || '无描述'}
- ${hasSubItems ? `**复合产品**: 包含 ${itemNamesToResolve.length} 个子项` : '**单一产品**'}
- **匹配产品数**: ${rows.length}

> ⚠️ **注意**: 库存数据来自产品数据库的静态快照，**并非实时 ERP 数据**。实际库存请以 ERP 系统为准。

${table}`;
}

// ==================================================================
//  lookupItemComponents
// ==================================================================

export const LOOKUP_ITEM_COMPONENTS_TOOL = {
  type: 'function',
  function: {
    name: 'lookupItemComponents',
    description:
      '通过完整型号（itemName）查询其在 DUKO 产品数据库中的最终组成 Product（productName）。返回每个组成件的组件类型（柜门组件/主体组件/额外组件）、SKU 和描述。当用户需要了解某个完整型号实际包含哪些 Product、或需要筛选特定组成件时调用此工具。',
    parameters: {
      type: 'object',
      properties: {
        itemName: {
          type: 'string',
          description: '完整型号名称，例如 "02B15"、"02W3012"、"02BTCR15"。来自用户提供的 itemName 或解析清单组合后的 itemName。',
        },
      },
      required: ['itemName'],
    },
  },
} as const satisfies ToolDefinition;

export function executeLookupItemComponents(args: Record<string, unknown>): string {
  const itemName = String(args.itemName ?? '').trim();
  if (!itemName) {
    return '## lookupItemComponents 结果\n\n**错误**: `itemName` 为必填项。';
  }

  const itemsMap = getItemsMap();
  const partsMap = getPartsMap();

  const exposedRecord = findRecordByItemNameCI(itemName);
  if (!exposedRecord) {
    return `## lookupItemComponents 结果\n\n**未找到**: Exposed-Items 中不存在产品 "${itemName}"。请核实名称是否正确。`;
  }

  const itemNamesToResolve: string[] = [];
  if (exposedRecord.subItemsName) {
    const subNames = exposedRecord.subItemsName.split(',').map((s) => s.trim()).filter(Boolean);
    itemNamesToResolve.push(...subNames);
  } else {
    itemNamesToResolve.push(itemName);
  }

  interface ComponentRow {
    sourceItem: string;
    componentType: string;
    sku: string;
    description: string;
  }

  const rows: ComponentRow[] = [];

  for (const resolveName of itemNamesToResolve) {
    const itemRow = itemsMap.get(resolveName);
    if (!itemRow) continue;

    if (itemRow.doorPart) {
      const partRow = partsMap.get(itemRow.doorPart);
      rows.push({
        sourceItem: resolveName,
        componentType: '柜门组件',
        sku: partRow?.sharedPartName || itemRow.doorPart,
        description: partRow?.description || '',
      });
    }

    if (itemRow.cabinetPart) {
      const partRow = partsMap.get(itemRow.cabinetPart);
      rows.push({
        sourceItem: resolveName,
        componentType: '主体组件',
        sku: partRow?.sharedPartName || itemRow.cabinetPart,
        description: partRow?.description || '',
      });
    }

    if (itemRow.extraPart) {
      const partRow = partsMap.get(itemRow.extraPart);
      rows.push({
        sourceItem: resolveName,
        componentType: '额外组件',
        sku: partRow?.sharedPartName || itemRow.extraPart,
        description: partRow?.description || '',
      });
    }
  }

  if (rows.length === 0) {
    return `## lookupItemComponents 结果\n\n**"${itemName}"** 在 Exposed-Items 中存在（${exposedRecord.mainDescription || '无描述'}），但无法解析其组成件。`;
  }

  const header = ['#', '物品名', '组件类型', 'SKU', '描述'];
  const tableRows: string[][] = rows.map((r, i) => [
    String(i + 1),
    r.sourceItem,
    r.componentType,
    r.sku,
    r.description || '-',
  ]);

  const table = markdownTable([header, ...tableRows]);

  const hasSubItems = itemNamesToResolve.length > 1;

  return `## lookupItemComponents 结果

- **查询**: "${itemName}" → ${exposedRecord.mainDescription || '无描述'}
- ${hasSubItems ? `**复合产品**: 包含 ${itemNamesToResolve.length} 个子项` : '**单一产品**'}
- **组成件数**: ${rows.length}

${table}`;
}

// ==================================================================
//  readGeneratedProducts
// ==================================================================

export const READ_GENERATED_PRODUCTS_TOOL = {
  type: 'function',
  function: {
    name: 'readGeneratedProducts',
    description:
      '读取当前已生成的产品清单（products 表）。返回带序号（# 列）的 Markdown 表格，包含 SKU、描述和数量。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
} as const satisfies ToolDefinition;

export function executeReadGeneratedProducts(state: MutableManifest): string {
  const { products } = state;

  if (!products || products.length === 0) {
    return '## 当前产品清单\n\n**当前没有生成后的产品清单。** 需要先在页面点击"生成产品清单"按钮生成产品清单，或让用户明确要求添加产品行。';
  }

  const header = ['#', 'SKU', '描述', '数量'];
  const rows: string[][] = products.map((p, i) => [
    String(i + 1),
    p.productName || '-',
    p.description || '-',
    String(p.quantity ?? 1),
  ]);

  const table = markdownTable([header, ...rows]);

  return `## 当前产品清单（共 ${products.length} 项）

${table}

> 使用 **序号**（第 1 列 \`#\`）作为 \`rowIndex\` 参数调用编辑工具。`;
}

/**
 * SKU 物品表生成模块
 *
 * 从 Parts.csv 生成 Items.csv：
 *   每行代表一个独立的"物品"（颜色 + 形状组合），
 *   将同形状的柜门（-D）、柜体（-C）、额外零件合并到同一行。
 *
 * 生成规则（优先级从上到下）：
 *   1. 补填名单填充者自身被跳过（不单独成行）
 *   2. -OL 后缀已在 sku-clean 里清除
 *   3. prefix 20   → 跳过（暂缓处理）
 *
 *   4. 确定 shapeCode 和归属列：
 *      后缀 -D → shape = rest去掉-D, 列 = doorPart
 *      后缀 -C → shape = rest去掉-C, 列 = cabinetPart
 *      无后缀 → shape = rest,        列 = extraPart
 *
 *   5. prefix 为 10 或 30（柜体，无颜色码）：
 *      按 shapeCode 匹配所有已有 item，填 cabinetPart
 *      若暂无匹配 item → 暂存入 pending，待后续 item 创建时回填
 *      同一 shapeCode 只会有一个 10/30 柜体
 *
 *   6. 其他 prefix（有颜色码）：
 *      colorCode = prefix
 *      itemName = colorCode + shapeCode → 创建或更新 item
 *      填入对应列（doorPart / cabinetPart / extraPart）
 *      随后检查 pendingCabinets 中是否有匹配 shapeCode → 回填 cabinetPart
 *
 *   7. 补填名单手动注入（itemName → { extraPart?, doorPart?, cabinetPart? }）
 *
 * 输出列（7 列）：
 *   itemName, colorCode, shapeTypeCode, shapeSizeCode, doorPart, cabinetPart, extraPart
 */

import { readFileSync, writeFileSync } from 'fs';
import Papa from 'papaparse';
import { ALL_STYLE_CODES, AMERICAN_STYLE_CODES, EUROPEAN_STYLE_CODES, NONE_EURO_STYLE_CODES, UNIPACK_STYLE_CODES } from '../constants.js';

// 物品表补填名单 —— { itemName: { extraPart?, doorPart?, cabinetPart? } }
// 手动补缺，填充者零件自身会被跳过（不单独成行）
const americanStyleSusan = Object.fromEntries(AMERICAN_STYLE_CODES.flatMap(color => [
  [`${color}BLS33`, { extraPart: "10BLS-Tray" }],
  [`${color}BLS36`, { extraPart: "10BLS-Tray" }],
]))
const europeanStyleSusan = Object.fromEntries(EUROPEAN_STYLE_CODES.flatMap(color => [
  [`${color}BLS33`, { extraPart: "30BLS-Tray" }],
  [`${color}BLS36`, { extraPart: "30BLS-Tray" }],
]))
const unipackStyleSusan = Object.fromEntries(UNIPACK_STYLE_CODES.flatMap(color => [
  [`${color}BLS33`, { extraPart: `${color} BLS-Tray` }],
  [`${color}BLS36`, { extraPart: `${color} BLS-Tray` }],
]))
const FILL_ITEMS_RULE: Record<string, { extraPart?: string; doorPart?: string; cabinetPart?: string }> = {
  ...americanStyleSusan,
  ...europeanStyleSusan,
  ...unipackStyleSusan,
};

const ITEMS_WHITELIST = new Set<string>([
  "TCR15_Wood Tray", "TCR18_Wood Tray",
]);


const AMERICAN_SET = new Set(AMERICAN_STYLE_CODES);
const EUROPEAN_SET = new Set(EUROPEAN_STYLE_CODES);

// ---- 类型 ----

/** Items 表一行 */
export interface ItemEntry {
  itemName: string;
  colorCode: string;
  shapeCode: string;
  shapeTypeCode: string;
  shapeSizeCode: string;
  doorPart: string;
  cabinetPart: string;
  extraPart: string;
}
// ---- 内部工具 ----

/**
 * 将 shapeCode 拆分为类型码和尺寸码。
 * shapeTypeCode  = 开头连续大写字母
 * shapeSizeCode  = 余下所有字符
 * 例如 "VC30L" → { shapeTypeCode: "VC", shapeSizeCode: "30L" }
 */
function splitShape(shape: string): { shapeTypeCode: string; shapeSizeCode: string } {
  const m = shape.match(/^([A-Z]+)/);
  const type = m ? m[1] : '';
  return { shapeTypeCode: type, shapeSizeCode: shape.substring(type.length) };
}

/** 读取 Parts.csv 的单零件名字段（只需 singlePartName） */
function readPartNames(filePath: string): string[] {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  return parsed.data.map((r) => String(r['singlePartName'] ?? '').trim()).filter(Boolean);
}

/**
 * 从补填名单的所有 value 中提取被用作填充者的零件名集合。
 * 这些零件不单独成行，仅在其他 item 的指定列中出现。
 */
function collectFillers(
  whitelist: Record<string, Partial<ItemEntry>>,
): Set<string> {
  const fillers = new Set<string>();
  for (const fill of Object.values(whitelist)) {
    if (fill.doorPart) fillers.add(fill.doorPart);
    if (fill.cabinetPart) fillers.add(fill.cabinetPart);
    if (fill.extraPart) fillers.add(fill.extraPart);
  }
  return fillers;
}

// ---- 公开 API ----

/**
 * 从 Parts.csv 生成 Items 表（独立查询表，每行 = 颜色+形状组合）。
 *
 * @param csvPath    - Parts.csv 路径
 * @param outputPath - 输出 CSV 路径；传 null 跳过写入
 */
export function generateItemsTable(
  csvPath: string,
  outputPath: string | null,
): { entries: ItemEntry[]; count: number } {
  const partNames = readPartNames(csvPath);
  const fillers = collectFillers(FILL_ITEMS_RULE);

  // items: itemName → ItemEntry
  const items = new Map<string, ItemEntry>();
  // pendingCabinets: shapeCode → cabinetName（孤立柜体，待匹配）
  const pendingCabinets = new Map<string, string>();

  for (const name of partNames) {
    // ── 跳过补填名单填充者 ──
    if (fillers.has(name)) {
      continue;
    }

    // ── 物品白名单直接返回 ──
    if (ITEMS_WHITELIST.has(name)) {
      const { shapeTypeCode, shapeSizeCode } = splitShape(name);
      items.set(name, {
        itemName: name,
        colorCode: '',
        shapeCode: name,
        shapeTypeCode,
        shapeSizeCode,
        doorPart: '',
        cabinetPart: name,
        extraPart: '',
      });
      continue
    }

    // 特殊处理 Glass Door
    if (name === "Glass Doors") {
      items.set(name, {
        itemName: name,
        colorCode: '',
        shapeCode: name,
        shapeTypeCode: 'GD',
        shapeSizeCode: '',
        doorPart: '',
        cabinetPart: name,
        extraPart: '',
      });
      continue
    }

    // 特殊处理 RD
    if (/^\d{2}RD\d{2}$/.test(name)) {
      const prefix = name.substring(0, 2);
      const rest = name.substring(4);
      items.set(name, {
        itemName: name,
        colorCode: prefix,
        shapeCode: name,
        shapeTypeCode: 'RD',
        shapeSizeCode: rest,
        doorPart: '',
        cabinetPart: name,
        extraPart: '',
      });
      continue
    }

    const prefix = name.substring(0, 2);
    const rest = name.substring(2);

    // ── 跳过未被任何风格覆盖的 prefix ──
    if (!ALL_STYLE_CODES.has(prefix) && prefix !== '10' && prefix !== '30') {
      continue;
    }

    // —— 跳过过时的一体 OV ——
    if (UNIPACK_STYLE_CODES.includes(prefix) && rest.startsWith('OV') && !rest.endsWith('24')) {
      continue;
    }

    // ── 确定 shapeCode 和归属列 ──
    let shapeCode: string;
    let column: 'doorPart' | 'cabinetPart' | 'extraPart';

    if (rest.endsWith('-D')) {
      shapeCode = rest.slice(0, -2);          // 去掉末尾 "-D" 得形状
      column = 'doorPart';
    } else if (rest.endsWith('-C')) {
      shapeCode = rest.slice(0, -2);          // 去掉末尾 "-C" 得形状
      column = 'cabinetPart';
    } else {
      shapeCode = rest;                       // 无后缀，整体定义为柜体
      column = 'cabinetPart';
    }

    // ── 分支：10/30 柜体（无颜色码）──
    if (prefix === '10' || prefix === '30') {
      const allowedStyles = prefix === '10' ? AMERICAN_SET : EUROPEAN_SET;
      for (const item of items.values()) {
        if (item.shapeCode === shapeCode && allowedStyles.has(item.colorCode)) {
          item.cabinetPart = name;
        }
      }

      // 始终存入 pending，确保后续创建的 item 也能回填
      // （如 30VC30L-C 先于 32VC30L-D 出现时，后者不会错过此柜体）
      pendingCabinets.set(shapeCode, name);
      continue;
    }

    // ── 分支：有颜色码（非 10/30）──
    const colorCode = prefix;
    const itemName = colorCode + shapeCode;

    if (!items.has(itemName)) {
      // 输出前再分离 type 和 size，不影响其他需要 shape code 的逻辑
      const { shapeTypeCode, shapeSizeCode } = splitShape(shapeCode);
      items.set(itemName, {
        itemName,
        colorCode,
        shapeCode,
        shapeTypeCode,
        shapeSizeCode,
        doorPart: '',
        cabinetPart: '',
        extraPart: '',
      });
    }

    const item = items.get(itemName)!;
    item[column] = name;

    // 检查是否有暂存柜体可回填（不清除，同 shape 的多个 item 共用同一柜体）
    if (column !== 'cabinetPart' && pendingCabinets.has(shapeCode)) {
      item.cabinetPart = pendingCabinets.get(shapeCode)!;
    }
  }

  // ── 填入名单手动注入 ──
  for (const [itemName, fill] of Object.entries(FILL_ITEMS_RULE)) {
    if (items.has(itemName)) {
      const item = items.get(itemName)!;
      if (fill.doorPart) item.doorPart = fill.doorPart;
      if (fill.cabinetPart) item.cabinetPart = fill.cabinetPart;
      if (fill.extraPart) item.extraPart = fill.extraPart;
    } else {
      // itemName 不存在 → 新建 item，仅填指定列
      items.set(itemName, {
        itemName,
        colorCode: '',
        shapeCode: '',
        shapeTypeCode: '',
        shapeSizeCode: '',
        doorPart: fill.doorPart ?? '',
        cabinetPart: fill.cabinetPart ?? '',
        extraPart: fill.extraPart ?? '',
      });
    }
  }

  // 按 itemName 排序
  const entries = [...items.values()].sort((a, b) =>
    a.itemName.localeCompare(b.itemName),
  );

  if (outputPath) {
    const csvContent = Papa.unparse(entries, {
      columns: ['itemName', 'colorCode', 'shapeTypeCode', 'shapeSizeCode', 'doorPart', 'cabinetPart', 'extraPart'],
    });
    writeFileSync(outputPath, csvContent, 'utf-8');
  }

  return { entries, count: entries.length };
}

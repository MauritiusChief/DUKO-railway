/**
 * 布局工具 —— 厨房布局识别与编辑
 *
 * 提供 LLM 通过 function calling 与布局互动：创建/删除墙岛台、
 * 插入/删除物品、管理连接关系等。
 *
 * 核心算法与 client/src/stores/layoutStore.ts 保持一致。
 * 从 services/layoutTools.ts 移入，使用 types/ 中的统一定义。
 */

import { markdownTable } from 'markdown-table';
import type { ToolDefinition } from '../types/tool.js';
import type {
  TrackSpan,
  BlockItemCategory,
  BlockItem,
  SectionBlock,
  LayoutWall,
  LayoutDocument,
  PositionedBlock,
  MutableLayout,
} from '../types/layout.js';

export type {
  TrackSpan,
  BlockItemCategory,
  BlockItem,
  SectionBlock,
  LayoutWall,
  LayoutDocument,
  PositionedBlock,
  MutableLayout,
};

// ==================================================================
//  基础工具函数
// ==================================================================

function uuid(): string {
  return crypto.randomUUID();
}

function sumWidths(blocks: SectionBlock[]): number {
  return blocks.reduce((s, b) => s + b.width, 0);
}

function targetTracks(category: BlockItemCategory): TrackSpan[] {
  switch (category) {
    case 'wall_cabinet':
    case 'range_hood':
    case 'window':
      return ['air'];
    case 'base_cabinet':
    case 'base_appliance_need_top':
    case 'base_appliance_without_top':
      return ['ground'];
    case 'tall_cabinet':
    case 'tall_appliance':
      return ['air', 'ground'];
    case 'gap':
      return ['air', 'ground'];
    default:
      return ['air'];
  }
}

// ==================================================================
//  位置计算
// ==================================================================

export function computePositions(blocks: SectionBlock[]): PositionedBlock[] {
  let pos = 0;
  return blocks.map((block) => {
    const positioned: PositionedBlock = { block, distanceFromLeft: pos };
    pos += block.width;
    return positioned;
  });
}

// ==================================================================
//  查找工具
// ==================================================================

function findWallInLayout(
  layout: LayoutDocument,
  wallId: string,
): { wall: LayoutWall; index: number } | null {
  const idx = layout.walls.findIndex((w) => w.id === wallId);
  if (idx !== -1) return { wall: layout.walls[idx], index: idx };
  return null;
}

function getTrackBlocks(wall: LayoutWall, track: TrackSpan): SectionBlock[] {
  return track === 'air' ? wall.airBlocks : wall.groundBlocks;
}

function findBlocksByItemId(blocks: SectionBlock[], itemId: string): { block: SectionBlock; index: number }[] {
  const result: { block: SectionBlock; index: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].items.some((item) => item.id === itemId)) {
      result.push({ block: blocks[i], index: i });
    }
  }
  return result;
}

function findAllBlocksByItemId(
  wall: LayoutWall,
  itemId: string,
): { track: TrackSpan; block: SectionBlock; index: number }[] {
  const result: { track: TrackSpan; block: SectionBlock; index: number }[] = [];
  for (const match of findBlocksByItemId(wall.airBlocks, itemId)) {
    result.push({ track: 'air', ...match });
  }
  for (const match of findBlocksByItemId(wall.groundBlocks, itemId)) {
    result.push({ track: 'ground', ...match });
  }
  return result;
}

// ==================================================================
//  插入算法
// ==================================================================

function insertBlocksAtEnd(blocks: SectionBlock[], newBlocks: SectionBlock[]): void {
  blocks.push(...newBlocks);
}

function insertBlockAtPosition(
  blocks: SectionBlock[],
  newBlock: SectionBlock,
  distanceFromLeft: number,
): void {
  let cumulative = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockStart = cumulative;
    const blockEnd = cumulative + block.width;

    if (distanceFromLeft < blockStart) {
      blocks.splice(i, 0, newBlock);
      return;
    }

    if (block.items.some((item) => item.category !== 'gap')) {
      cumulative = blockEnd;
      continue;
    }

    if (distanceFromLeft >= blockStart && distanceFromLeft < blockEnd) {
      const leftGapWidth = distanceFromLeft - blockStart;
      const rightGapWidth = blockEnd - distanceFromLeft - newBlock.width;

      if (rightGapWidth === 0) {
        const gapItem = block.items[0];
        const replacements: SectionBlock[] = [];
        if (leftGapWidth > 0) {
          replacements.push({
            id: uuid(),
            width: leftGapWidth,
            items: [{ ...gapItem, id: uuid() }],
          });
        }
        replacements.push(newBlock);
        blocks.splice(i, 1, ...replacements);
        return;
      }

      if (rightGapWidth > 0) {
        const gapItem = block.items[0];
        const replacements: SectionBlock[] = [];
        if (leftGapWidth > 0) {
          replacements.push({
            id: uuid(),
            width: leftGapWidth,
            items: [{ ...gapItem, id: uuid() }],
          });
        }
        replacements.push(newBlock);
        replacements.push({
          id: uuid(),
          width: rightGapWidth,
          items: [{ ...gapItem, id: uuid() }],
        });
        blocks.splice(i, 1, ...replacements);
        return;
      }

      if (rightGapWidth < 0) {
        blocks.splice(i, 1, newBlock);
        return;
      }

      blocks.splice(i, 0, newBlock);
      if (rightGapWidth > 0) {
        block.width = rightGapWidth;
      } else {
        blocks.splice(i + 1, 1);
      }
      return;
    }

    cumulative = blockEnd;
  }

  if (distanceFromLeft > cumulative) {
    const isGap = newBlock.items[0]?.category === 'gap';
    if (!isGap) {
      const gapWidth = distanceFromLeft - cumulative;
      blocks.push({
        id: uuid(),
        width: gapWidth,
        items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
      });
    }
  }
  blocks.push(newBlock);
}

// ==================================================================
//  删除算法
// ==================================================================

function deleteBlockDynamic(blocks: SectionBlock[], blockIndex: number): void {
  blocks.splice(blockIndex, 1);
}

function deleteBlockStatic(blocks: SectionBlock[], blockIndex: number): void {
  const block = blocks[blockIndex];
  const gapBlock: SectionBlock = {
    id: uuid(),
    width: block.width,
    items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
  };
  blocks.splice(blockIndex, 1, gapBlock);
}

// ==================================================================
//  空挡对齐
// ==================================================================

function alignAirGround(wall: LayoutWall): void {
  const dualItemIds: string[] = [];
  for (const block of wall.airBlocks) {
    for (const item of block.items) {
      if (item.category === 'tall_cabinet' || item.category === 'tall_appliance') {
        dualItemIds.push(item.id);
      }
    }
  }

  for (const itemId of dualItemIds) {
    const airIdx = wall.airBlocks.findIndex((b) => b.items.some((i) => i.id === itemId));
    const groundIdx = wall.groundBlocks.findIndex((b) => b.items.some((i) => i.id === itemId));
    if (airIdx === -1 || groundIdx === -1) continue;

    const airBefore = sumWidths(wall.airBlocks.slice(0, airIdx));
    const groundBefore = sumWidths(wall.groundBlocks.slice(0, groundIdx));

    if (airBefore > groundBefore) {
      const gapWidth = airBefore - groundBefore;
      wall.groundBlocks.splice(groundIdx, 0, {
        id: uuid(),
        width: gapWidth,
        items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
      });
    } else if (groundBefore > airBefore) {
      const gapWidth = groundBefore - airBefore;
      wall.airBlocks.splice(airIdx, 0, {
        id: uuid(),
        width: gapWidth,
        items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
      });
    }
  }
}

// ==================================================================
//  序列化（布局 → Markdown 表格）
// ==================================================================

function serializeWall(wall: LayoutWall): string {
  let text = `### 墙: "${wall.name}" (ID: ${wall.id})\n`;
  text += `- 总宽度: ${wall.width}" | 左侧暴露: ${wall.exposedLeft ? '是' : '否'} | 右侧暴露: ${wall.exposedRight ? '是' : '否'} | 后侧暴露: ${wall.exposedBack ? '是' : '否'}\n`;
  if (wall.connectedWallIds.length > 0) {
    text += `- L 形连接: ${wall.connectedWallIds.join(', ')}\n`;
  }
  if (wall.backToBackIslandIds.length > 0) {
    text += `- 背靠背: ${wall.backToBackIslandIds.join(', ')}\n`;
  }
  text += '\n';

  const header = ['#', '宽度', '距左', '物品'];

  text += '**空中轨道:**\n';
  const airPos = computePositions(wall.airBlocks);
  if (airPos.length === 0) {
    text += '(空)\n';
  } else {
    const airRows = airPos.map((p, i) => {
      const items = p.block.items.map((it) => `${it.category}:${it.sku}`).join(' + ');
      return [String(i + 1), String(p.block.width), String(p.distanceFromLeft), items];
    });
    text += markdownTable([header, ...airRows]) + '\n';
  }

  text += '\n**地面轨道:**\n';
  const groundPos = computePositions(wall.groundBlocks);
  if (groundPos.length === 0) {
    text += '(空)\n';
  } else {
    const groundRows = groundPos.map((p, i) => {
      const items = p.block.items.map((it) => `${it.category}:${it.sku}`).join(' + ');
      return [String(i + 1), String(p.block.width), String(p.distanceFromLeft), items];
    });
    text += markdownTable([header, ...groundRows]) + '\n';
  }

  return text;
}

function serializeLayout(layout: LayoutDocument): string {
  if (layout.walls.length === 0) {
    return '当前布局中没有任何墙。请使用 createWall 工具添加。';
  }

  let text = `## 布局: "${layout.name}" (ID: ${layout.id})\n\n`;
  for (const wall of layout.walls) {
    text += serializeWall(wall) + '\n';
  }
  return text;
}

// ==================================================================
//  工具定义 — readLayout
// ==================================================================

export const READ_LAYOUT_TOOL = {
  type: 'function',
  function: {
    name: 'readLayout',
    description:
      '读取当前布局的完整信息。返回所有墙和岛台的名称、ID、宽度、暴露面、连接关系，以及各轨道物品列表（含位置、宽度、分类、SKU）。在对布局进行任何修改之前应先调用此工具了解当前状态。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
} as const satisfies ToolDefinition;

export function executeReadLayout(state: MutableLayout): string {
  return serializeLayout(state.layout);
}

// ==================================================================
//  工具定义 — createWall
// ==================================================================

export const CREATE_WALL_TOOL = {
  type: 'function',
  function: {
    name: 'createWall',
    description:
      '在布局中创建一面新墙/岛台。name 若不提供则自动编号。width 为总宽度（英寸）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '墙的名称（可选，不填则自动编号）' },
        width: { type: 'number', description: '总宽度（英寸）' },
      },
      required: ['width'],
    },
  },
} as const satisfies ToolDefinition;

export function executeCreateWall(state: MutableLayout, args: Record<string, unknown>): string {
  const providedName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : '';
  const width = typeof args.width === 'number' && args.width > 0 ? args.width : 0;
  if (width <= 0) return '错误: width 必须为正数。';

  const num = state.layout.walls.length + 1;
  const name = providedName || `Wall ${num}`;

  const wall: LayoutWall = {
    id: uuid(),
    name,
    width,
    exposedLeft: false,
    exposedRight: false,
    exposedBack: false,
    airBlocks: [],
    groundBlocks: [],
    connectedWallIds: [],
    backToBackIslandIds: [],
  };
  state.layout.walls.push(wall);
  return `已创建墙 "${name}" (ID: ${wall.id})，宽度 ${width}"}。`;
}

// ==================================================================
//  工具定义 — deleteWall
// ==================================================================

export const DELETE_WALL_TOOL = {
  type: 'function',
  function: {
    name: 'deleteWall',
    description: '从布局中删除指定的墙或岛台。wallId 来自 readLayout 中显示的 ID。',
    parameters: {
      type: 'object',
      properties: {
        wallId: { type: 'string', description: '要删除的墙/岛台的 ID' },
      },
      required: ['wallId'],
    },
  },
} as const satisfies ToolDefinition;

export function executeDeleteWall(state: MutableLayout, args: Record<string, unknown>): string {
  const wallId = String(args.wallId ?? '').trim();
  if (!wallId) return '错误: wallId 为必填项。';

  const found = state.layout.walls.some((w) => w.id === wallId);
  if (!found) return `错误: 未找到 ID 为 "${wallId}" 的墙。`;

  state.layout.walls = state.layout.walls.filter((w) => w.id !== wallId);
  return `已删除 ID 为 "${wallId}" 的墙。`;
}

// ==================================================================
//  工具定义 — insertItem
// ==================================================================

const CATEGORY_DESC =
  '物品分类: wall_cabinet(吊柜), base_cabinet(地柜), tall_cabinet(高柜-通天), gap(空挡), ' +
  'range_hood(抽油烟机), window(窗户), tall_appliance(通天电器如冰箱), ' +
  'base_appliance_need_top(需台面电器如洗碗机), base_appliance_without_top(免台面电器如灶台)';

export const INSERT_ITEM_TOOL = {
  type: 'function',
  function: {
    name: 'insertItem',
    description:
      `在指定墙/岛台的最左侧（轨道末尾）插入一个或多个物品。` +
      `会自动将物品推到最左侧可插入位置。${CATEGORY_DESC}。` +
      `全高物品（tall_cabinet/tall_appliance）会自动同时在 air 和 ground 轨道插入。` +
      `墙吊柜（wall_cabinet）支持通过 stackedSkus 堆叠。`,
    parameters: {
      type: 'object',
      properties: {
        wallId: { type: 'string', description: 'wall/island 的 ID' },
        track: { type: 'string', description: '轨道："air"（空中）或 "ground"（地面）。全高物品会自动忽略此参数。', enum: ['air', 'ground'] },
        category: { type: 'string', description: CATEGORY_DESC },
        sku: { type: 'string', description: 'SKU 代码（柜体如 "02B15"）或具体名称（电器如 "refrigerator"）' },
        width: { type: 'number', description: '宽度（英寸）' },
        stackedSkus: {
          type: 'array',
          items: { type: 'string' },
          description: '叠放吊柜的 SKU 列表（仅 wall_cabinet/tall_cabinet/tall_appliance 支持，仅加在 air 轨）',
        },
      },
      required: ['wallId', 'category', 'sku', 'width'],
    },
  },
} as const satisfies ToolDefinition;

export function executeInsertItem(state: MutableLayout, args: Record<string, unknown>): string {
  const wallId = String(args.wallId ?? '').trim();
  const track = (args.track as TrackSpan) || 'air';
  const category = String(args.category ?? '') as BlockItemCategory;
  const sku = String(args.sku ?? '').trim() || category;
  const width = typeof args.width === 'number' && args.width > 0 ? args.width : 0;
  const stackedSkus: string[] = Array.isArray(args.stackedSkus)
    ? args.stackedSkus.filter((s) => typeof s === 'string' && s.trim())
    : [];

  if (width <= 0) return '错误: width 必须为正数。';

  const ref = findWallInLayout(state.layout, wallId);
  if (!ref) return `错误: 未找到 ID 为 "${wallId}" 的墙或岛台。`;

  const tracks = targetTracks(category);
  const isDual = tracks.length === 2 && category !== 'gap';

  if (isDual) {
    const sharedMainItem: BlockItem = { id: uuid(), category, sku };
    const stackedItems: BlockItem[] = stackedSkus.map((s) => ({
      id: uuid(), category: 'wall_cabinet' as const, sku: s,
    }));

    const airBlock: SectionBlock = {
      id: uuid(), width,
      items: [{ ...sharedMainItem }, ...stackedItems],
    };
    const groundBlock: SectionBlock = {
      id: uuid(), width,
      items: [{ ...sharedMainItem }],
    };

    insertBlocksAtEnd(ref.wall.airBlocks, [airBlock]);
    insertBlocksAtEnd(ref.wall.groundBlocks, [groundBlock]);
    alignAirGround(ref.wall);

    return `已在 "${ref.wall.name}" 同时插入 ${category}（${width}"）到 air 和 ground 轨道。` +
      (stackedItems.length > 0 ? ` 附带 ${stackedItems.length} 个叠放吊柜。` : '');
  } else {
    const actualTrack = category === 'gap' ? track : tracks[0];
    const items: BlockItem[] = [{ id: uuid(), category, sku }];
    for (const s of stackedSkus) {
      items.push({ id: uuid(), category: 'wall_cabinet', sku: s });
    }

    const newBlock: SectionBlock = { id: uuid(), width, items };
    const blocks = getTrackBlocks(ref.wall, actualTrack);
    insertBlocksAtEnd(blocks, [newBlock]);
    alignAirGround(ref.wall);

    return `已在 "${ref.wall.name}" 的 ${actualTrack} 轨道插入 ${category}（${width}"）。` +
      (stackedSkus.length > 0 ? ` 附带 ${stackedSkus.length} 个叠放吊柜。` : '');
  }
}

// ==================================================================
//  工具定义 — deleteItem
// ==================================================================

export const DELETE_ITEM_TOOL = {
  type: 'function',
  function: {
    name: 'deleteItem',
    description:
      '删除指定物品。itemId 来自 readLayout 返回的物品 SKU/名称旁的 id（可在表格中查看）。' +
      'mode 为 "static" 时原位置保留同宽空挡，"dynamic" 时右侧物品自动左移。' +
      '全高物品会自动从 air 和 ground 两轨同时删除。gap 的 static 删除会被自动转为 dynamic。',
    parameters: {
      type: 'object',
      properties: {
        wallId: { type: 'string', description: 'wall/island 的 ID' },
        itemId: { type: 'string', description: '要删除的物品 ID' },
        mode: { type: 'string', description: '"static"（留空位）或 "dynamic"（左侧滑动）', enum: ['static', 'dynamic'] },
      },
      required: ['wallId', 'itemId', 'mode'],
    },
  },
} as const satisfies ToolDefinition;

export function executeDeleteItem(state: MutableLayout, args: Record<string, unknown>): string {
  const wallId = String(args.wallId ?? '').trim();
  const itemId = String(args.itemId ?? '').trim();
  const mode = (String(args.mode ?? 'dynamic') as 'static' | 'dynamic') || 'dynamic';

  if (!itemId) return '错误: itemId 为必填项。';

  const ref = findWallInLayout(state.layout, wallId);
  if (!ref) return `错误: 未找到 ID 为 "${wallId}" 的墙或岛台。`;

  const allMatches = findAllBlocksByItemId(ref.wall, itemId);
  if (allMatches.length === 0) return `错误: 未找到 item ID 为 "${itemId}" 的物品。`;

  const isGap = allMatches.some((m) => m.block.items.some((it) => it.id === itemId && it.category === 'gap'));
  const effectiveMode = isGap ? 'dynamic' : mode;

  const airIndices = allMatches
    .filter((m) => m.track === 'air')
    .map((m) => m.index)
    .sort((a, b) => b - a);
  const groundIndices = allMatches
    .filter((m) => m.track === 'ground')
    .map((m) => m.index)
    .sort((a, b) => b - a);

  for (const idx of airIndices) {
    if (effectiveMode === 'static') {
      deleteBlockStatic(ref.wall.airBlocks, idx);
    } else {
      deleteBlockDynamic(ref.wall.airBlocks, idx);
    }
  }
  for (const idx of groundIndices) {
    if (effectiveMode === 'static') {
      deleteBlockStatic(ref.wall.groundBlocks, idx);
    } else {
      deleteBlockDynamic(ref.wall.groundBlocks, idx);
    }
  }

  alignAirGround(ref.wall);

  const trackLabels = [...new Set(allMatches.map((m) => m.track))].join(' + ');
  return `已从 "${ref.wall.name}" 的 ${trackLabels} 轨道${effectiveMode === 'static' ? '静态' : '动态'}删除物品 ${itemId}。`;
}

// ==================================================================
//  工具定义 — insertItemAtPosition
// ==================================================================

export const INSERT_ITEM_AT_POSITION_TOOL = {
  type: 'function',
  function: {
    name: 'insertItemAtPosition',
    description:
      '在指定墙/岛台的指定距左距离（英寸）处精确插入一个物品。' +
      '如果目标位置是 gap，会拆分或替换 gap；如果不是 gap，会将右侧物品挤开。' +
      '全高物品会自动同时在 air 和 ground 两轨的相同距离插入。',
    parameters: {
      type: 'object',
      properties: {
        wallId: { type: 'string', description: 'wall/island 的 ID' },
        track: { type: 'string', description: '轨道："air" 或 "ground"', enum: ['air', 'ground'] },
        category: { type: 'string', description: CATEGORY_DESC },
        sku: { type: 'string', description: 'SKU 代码或具体名称' },
        width: { type: 'number', description: '宽度（英寸）' },
        distanceFromLeft: { type: 'number', description: '距左距离（英寸）' },
        stackedSkus: { type: 'array', items: { type: 'string' }, description: '叠放吊柜的 SKU 列表（仅加在 air 轨）' },
      },
      required: ['wallId', 'category', 'sku', 'width', 'distanceFromLeft'],
    },
  },
} as const satisfies ToolDefinition;

export function executeInsertItemAtPosition(state: MutableLayout, args: Record<string, unknown>): string {
  const wallId = String(args.wallId ?? '').trim();
  const track = (args.track as TrackSpan) || 'air';
  const category = String(args.category ?? '') as BlockItemCategory;
  const sku = String(args.sku ?? '').trim() || category;
  const width = typeof args.width === 'number' && args.width > 0 ? args.width : 0;
  const distanceFromLeft = typeof args.distanceFromLeft === 'number' ? args.distanceFromLeft : 0;
  const stackedSkus: string[] = Array.isArray(args.stackedSkus)
    ? args.stackedSkus.filter((s) => typeof s === 'string' && s.trim())
    : [];

  if (width <= 0) return '错误: width 必须为正数。';

  const ref = findWallInLayout(state.layout, wallId);
  if (!ref) return `错误: 未找到 ID 为 "${wallId}" 的墙或岛台。`;

  const tracks = targetTracks(category);
  const isDual = tracks.length === 2 && category !== 'gap';

  if (isDual) {
    const sharedMainItem: BlockItem = { id: uuid(), category, sku };
    const stackedItems: BlockItem[] = stackedSkus.map((s) => ({
      id: uuid(), category: 'wall_cabinet' as const, sku: s,
    }));

    const airBlock: SectionBlock = { id: uuid(), width, items: [{ ...sharedMainItem }, ...stackedItems] };
    const groundBlock: SectionBlock = { id: uuid(), width, items: [{ ...sharedMainItem }] };

    insertBlockAtPosition(ref.wall.airBlocks, airBlock, distanceFromLeft);
    insertBlockAtPosition(ref.wall.groundBlocks, groundBlock, distanceFromLeft);
    alignAirGround(ref.wall);

    return `已在 "${ref.wall.name}" 的 air+ground 两轨距左 ${distanceFromLeft}" 处插入 ${category}（${width}"）。`;
  } else {
    const actualTrack = category === 'gap' ? track : tracks[0];
    const items: BlockItem[] = [{ id: uuid(), category, sku }];
    for (const s of stackedSkus) {
      items.push({ id: uuid(), category: 'wall_cabinet', sku: s });
    }

    const newBlock: SectionBlock = { id: uuid(), width, items };
    const blocks = getTrackBlocks(ref.wall, actualTrack);
    insertBlockAtPosition(blocks, newBlock, distanceFromLeft);
    alignAirGround(ref.wall);

    return `已在 "${ref.wall.name}" 的 ${actualTrack} 轨距左 ${distanceFromLeft}" 处插入 ${category}（${width}"）。`;
  }
}

// ==================================================================
//  工具定义 — updateWallProperties
// ==================================================================

export const UPDATE_WALL_PROPERTIES_TOOL = {
  type: 'function',
  function: {
    name: 'updateWallProperties',
    description: '修改墙/岛台的名称、总宽度或暴露面属性。只传需要修改的字段。',
    parameters: {
      type: 'object',
      properties: {
        wallId: { type: 'string', description: 'wall/island 的 ID' },
        name: { type: 'string', description: '新名称（可选）' },
        width: { type: 'number', description: '新总宽度（可选）' },
        exposedLeft: { type: 'boolean', description: '左侧是否暴露（可选）' },
        exposedRight: { type: 'boolean', description: '右侧是否暴露（可选）' },
        exposedBack: { type: 'boolean', description: '后侧是否暴露（可选）' },
      },
      required: ['wallId'],
    },
  },
} as const satisfies ToolDefinition;

export function executeUpdateWallProperties(state: MutableLayout, args: Record<string, unknown>): string {
  const wallId = String(args.wallId ?? '').trim();
  if (!wallId) return '错误: wallId 为必填项。';

  const ref = findWallInLayout(state.layout, wallId);
  if (!ref) return `错误: 未找到 ID 为 "${wallId}" 的墙或岛台。`;

  const changes: string[] = [];
  const wall = ref.wall;

  if (typeof args.name === 'string' && args.name.trim()) {
    wall.name = args.name.trim();
    changes.push(`名称 → "${wall.name}"`);
  }
  if (typeof args.width === 'number' && args.width > 0) {
    wall.width = args.width;
    changes.push(`总宽 → ${wall.width}"`);
  }
  if (typeof args.exposedLeft === 'boolean') {
    wall.exposedLeft = args.exposedLeft;
    changes.push(`左侧暴露 → ${wall.exposedLeft}`);
  }
  if (typeof args.exposedRight === 'boolean') {
    wall.exposedRight = args.exposedRight;
    changes.push(`右侧暴露 → ${wall.exposedRight}`);
  }
  if (typeof args.exposedBack === 'boolean') {
    wall.exposedBack = args.exposedBack;
    changes.push(`后侧暴露 → ${wall.exposedBack}`);
  }

  if (changes.length === 0) return '未做任何修改。';
  return `已更新 "${wall.name}": ${changes.join('; ')}。`;
}

// ==================================================================
//  工具定义 — connectWalls / disconnectWalls
// ==================================================================

export const CONNECT_WALLS_TOOL = {
  type: 'function',
  function: {
    name: 'connectWalls',
    description: '建立两面墙的 L 形连接关系。两面墙必须都存在且不能是岛台。',
    parameters: {
      type: 'object',
      properties: {
        wallId1: { type: 'string', description: '第一面墙的 ID' },
        wallId2: { type: 'string', description: '第二面墙的 ID' },
      },
      required: ['wallId1', 'wallId2'],
    },
  },
} as const satisfies ToolDefinition;

export function executeConnectWalls(state: MutableLayout, args: Record<string, unknown>): string {
  const id1 = String(args.wallId1 ?? '').trim();
  const id2 = String(args.wallId2 ?? '').trim();
  if (!id1 || !id2) return '错误: wallId1 和 wallId2 均为必填。';
  if (id1 === id2) return '错误: 不能连接同一面墙。';

  const w1 = state.layout.walls.find((w) => w.id === id1);
  const w2 = state.layout.walls.find((w) => w.id === id2);
  if (!w1) return `错误: 未找到 ID "${id1}" 的墙。`;
  if (!w2) return `错误: 未找到 ID "${id2}" 的墙。`;

  if (!w1.connectedWallIds.includes(id2)) w1.connectedWallIds.push(id2);
  if (!w2.connectedWallIds.includes(id1)) w2.connectedWallIds.push(id1);
  return `已建立 "${w1.name}" ↔ "${w2.name}" 的 L 形连接。`;
}

export const DISCONNECT_WALLS_TOOL = {
  type: 'function',
  function: {
    name: 'disconnectWalls',
    description: '解除两面墙的 L 形连接关系。',
    parameters: {
      type: 'object',
      properties: {
        wallId1: { type: 'string' },
        wallId2: { type: 'string' },
      },
      required: ['wallId1', 'wallId2'],
    },
  },
} as const satisfies ToolDefinition;

export function executeDisconnectWalls(state: MutableLayout, args: Record<string, unknown>): string {
  const id1 = String(args.wallId1 ?? '').trim();
  const id2 = String(args.wallId2 ?? '').trim();

  const w1 = state.layout.walls.find((w) => w.id === id1);
  const w2 = state.layout.walls.find((w) => w.id === id2);

  if (w1) w1.connectedWallIds = w1.connectedWallIds.filter((id) => id !== id2);
  if (w2) w2.connectedWallIds = w2.connectedWallIds.filter((id) => id !== id1);
  return `已解除连接。`;
}

// ==================================================================
//  工具定义 — connectIslands / disconnectIslands
// ==================================================================

export const CONNECT_ISLANDS_TOOL = {
  type: 'function',
  function: {
    name: 'connectIslands',
    description: '建立两个岛台的相背关系。',
    parameters: {
      type: 'object',
      properties: {
        islandId1: { type: 'string' },
        islandId2: { type: 'string' },
      },
      required: ['islandId1', 'islandId2'],
    },
  },
} as const satisfies ToolDefinition;

export function executeConnectIslands(state: MutableLayout, args: Record<string, unknown>): string {
  const id1 = String(args.islandId1 ?? '').trim();
  const id2 = String(args.islandId2 ?? '').trim();

  const w1 = state.layout.walls.find((w) => w.id === id1);
  const w2 = state.layout.walls.find((w) => w.id === id2);
  if (!w1) return `错误: 未找到 ID "${id1}" 的墙。`;
  if (!w2) return `错误: 未找到 ID "${id2}" 的墙。`;

  if (!w1.backToBackIslandIds.includes(id2)) w1.backToBackIslandIds.push(id2);
  if (!w2.backToBackIslandIds.includes(id1)) w2.backToBackIslandIds.push(id1);
  return `已建立墙 "${w1.name}" ↔ "${w2.name}" 的背靠背关系。`;
}

export const DISCONNECT_ISLANDS_TOOL = {
  type: 'function',
  function: {
    name: 'disconnectIslands',
    description: '解除两个岛台的相背关系。',
    parameters: {
      type: 'object',
      properties: {
        islandId1: { type: 'string' },
        islandId2: { type: 'string' },
      },
      required: ['islandId1', 'islandId2'],
    },
  },
} as const satisfies ToolDefinition;

export function executeDisconnectIslands(state: MutableLayout, args: Record<string, unknown>): string {
  const id1 = String(args.islandId1 ?? '').trim();
  const id2 = String(args.islandId2 ?? '').trim();

  const w1 = state.layout.walls.find((w) => w.id === id1);
  const w2 = state.layout.walls.find((w) => w.id === id2);

  if (w1) w1.backToBackIslandIds = w1.backToBackIslandIds.filter((id) => id !== id2);
  if (w2) w2.backToBackIslandIds = w2.backToBackIslandIds.filter((id) => id !== id1);
  return `已解除背靠背关系。`;
}

// ==================================================================
//  工具集合与分发
// ==================================================================

export const LAYOUT_TOOLS: ToolDefinition[] = [
  READ_LAYOUT_TOOL,
  CREATE_WALL_TOOL,
  DELETE_WALL_TOOL,
  INSERT_ITEM_TOOL,
  DELETE_ITEM_TOOL,
  INSERT_ITEM_AT_POSITION_TOOL,
  UPDATE_WALL_PROPERTIES_TOOL,
  CONNECT_WALLS_TOOL,
  DISCONNECT_WALLS_TOOL,
  CONNECT_ISLANDS_TOOL,
  DISCONNECT_ISLANDS_TOOL,
];

export async function executeLayoutTool(
  state: MutableLayout,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (toolName) {
    case 'readLayout': return executeReadLayout(state);
    case 'createWall': return executeCreateWall(state, args);
    case 'deleteWall': return executeDeleteWall(state, args);
    case 'insertItem': return executeInsertItem(state, args);
    case 'deleteItem': return executeDeleteItem(state, args);
    case 'insertItemAtPosition': return executeInsertItemAtPosition(state, args);
    case 'updateWallProperties': return executeUpdateWallProperties(state, args);
    case 'connectWalls': return executeConnectWalls(state, args);
    case 'disconnectWalls': return executeDisconnectWalls(state, args);
    case 'connectIslands': return executeConnectIslands(state, args);
    case 'disconnectIslands': return executeDisconnectIslands(state, args);
    default: return `未知工具: ${toolName}`;
  }
}

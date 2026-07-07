/**
 * Layout 状态管理 —— Zustand store
 *
 * 仅维护当前激活的布局文档，通过 localStorage 自动持久化。
 * 布局的导入/导出通过 JSON 字符串完成。
 * 内部统一使用 "wall" 表示墙面/岛台，UI 中显示为组合标签 "墙面/岛台"。
 */
import { create } from 'zustand';
import type {
  LayoutDocument,
  LayoutWall,
  SectionBlock,
  BlockItem,
  BlockItemCategory,
  TrackSpan,
  PositionedBlock,
} from '../types';
import type { SSEEvent } from '../lib/sse';

// ==================================================================
//  工具函数
// ==================================================================

function uuid(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

/** 判断 category 是否占用双轨（air + ground 各一个 block） */
function isDualTrack(category: BlockItemCategory): boolean {
  return category === 'tall_cabinet' || category === 'tall_appliance';
}

/** 判断 category 属于空中轨道 */
function isAirTrack(category: BlockItemCategory): boolean {
  return category === 'wall_cabinet'
    || category === 'stuffed_gap'
    || category === 'gaplike_item'
    || category === 'filler'
    || isDualTrack(category);
}

/** 判断 category 属于地面轨道 */
function isGroundTrack(category: BlockItemCategory): boolean {
  return category === 'base_cabinet'
    || category === 'base_appliance_need_top'
    || category === 'base_appliance_without_top'
    || category === 'stuffed_gap'
    || category === 'gaplike_item'
    || category === 'filler'
    || isDualTrack(category);
}

// ==================================================================
//  localStorage 持久化（仅存储当前激活的布局）
// ==================================================================

const STORAGE_KEY = 'duko_layout';

function loadFromStorage(): LayoutDocument | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.id && Array.isArray(parsed.walls)) {
        return parsed as LayoutDocument;
      }
    }
  } catch {
    /* 数据损坏，静默回退 */
  }
  return null;
}

function syncToStorage(layout: LayoutDocument | null): void {
  try {
    if (layout) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* localStorage 不可用，静默忽略 */
  }
}

// ==================================================================
//  位置计算
// ==================================================================

/** 对某个轨道的 blocks 数组实时计算每个块距最左的距离 */
export function computePositions(blocks: SectionBlock[]): PositionedBlock[] {
  let pos = 0;
  return blocks.map((block) => {
    const positioned: PositionedBlock = { block, distanceFromLeft: pos };
    pos += block.width;
    return positioned;
  });
}

// ==================================================================
//  辅助：在 activeLayout 中定位墙
// ==================================================================

interface WallRef {
  layout: LayoutDocument;
  wall: LayoutWall;
  index: number;
}

function findWallInLayout(layout: LayoutDocument, wallId: string): WallRef | null {
  const idx = layout.walls.findIndex((w) => w.id === wallId);
  if (idx !== -1) {
    return { layout, wall: layout.walls[idx], index: idx };
  }
  return null;
}

/** 获取块的 airBlocks / groundBlocks 引用 */
function getTrackBlocks(wall: LayoutWall, track: TrackSpan): SectionBlock[] {
  return track === 'air' ? wall.airBlocks : wall.groundBlocks;
}

/** 在 blocks 数组中查找包含指定 itemId 的块 */
function findBlocksByItemId(blocks: SectionBlock[], itemId: string): { block: SectionBlock; index: number }[] {
  const result: { block: SectionBlock; index: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].items.some((item) => item.id === itemId)) {
      result.push({ block: blocks[i], index: i });
    }
  }
  return result;
}

// ==================================================================
//  插入算法：在最左侧（数组末尾）插入
// ==================================================================

function insertBlocksAtEnd(blocks: SectionBlock[], newBlocks: SectionBlock[]): void {
  blocks.push(...newBlocks);
}

// ==================================================================
//  精确插入算法：在指定 distanceFromLeft 处插入
// ==================================================================

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
      // 在 block i 之前没有空间，需要向右挤
      blocks.splice(i, 0, newBlock);
      return;
    }

    if (block.items.some((item) => item.category !== 'gap')) {
      // 非 gap 块，不能直接落在这里
      cumulative = blockEnd;
      continue;
    }

    // gap 块
    if (distanceFromLeft >= blockStart && distanceFromLeft < blockEnd) {
      const leftGapWidth = distanceFromLeft - blockStart;
      const rightGapWidth = blockEnd - distanceFromLeft - newBlock.width;

      if (rightGapWidth === 0) {
        // 新块刚好填剩余 → 替换 gap 为 [左gap, 新块]（右gap 宽度0=消除）
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
        // 拆分 gap
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

      // leftGapWidth === 0 → 直接在 gap 前放新块，gap 剩余宽度缩小
      if (rightGapWidth < 0) {
        // 新块比 gap 宽 → 替换 gap，剩余宽度向右挤
        const overflow = newBlock.width - block.width;
        blocks.splice(i, 1, newBlock);
        // 将溢出宽度从右侧非 gap 块挤开 —— 简化为直接插入
        return;
      }

      // rightGapWidth >= 0
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

  // 落在所有块之后 → 非 gap 块需补支撑 gap，gap 自身则直接追加
  if (distanceFromLeft > cumulative) {
    const isGap = newBlock.items[0]?.category === 'gap';
    if (!isGap) {
      const gapWidth = distanceFromLeft - cumulative;
      const gapBlock: SectionBlock = {
        id: uuid(),
        width: gapWidth,
        items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
      };
      blocks.push(gapBlock);
    }
  }
  blocks.push(newBlock);
}

// ==================================================================
//  动态删除：删除块，右侧自然左移（索引不变，位置靠计算）
// ==================================================================

function deleteBlockDynamic(blocks: SectionBlock[], blockIndex: number): void {
  blocks.splice(blockIndex, 1);
}

// ==================================================================
//  静态删除：将块替换为同宽度的 gap
// ==================================================================

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
//  空挡对齐：确保全高物品在 air / ground 两轨的距左位置一致
//  策略：优先削长轨左侧 gap，不够再补短轨。
// ==================================================================

/** 对墙/岛台的双轨进行空挡对齐。
 *  遍历所有全高物品（tall_cabinet / tall_appliance），
 *  若其在 airBlocks 和 groundBlocks 中的距左位置不一致：
 *  1. 先检查长轨侧双轨块左侧紧邻是否为 gap —— 若是，优先削减它
 *  2. gap 不够覆盖差值时，削掉 gap 后剩余差值补到短轨侧
 *  3. 左侧紧邻非 gap 时才回退到旧行为：直接在短轨插入 gap */
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

    const airBefore = wall.airBlocks.slice(0, airIdx).reduce((s, b) => s + b.width, 0);
    const groundBefore = wall.groundBlocks.slice(0, groundIdx).reduce((s, b) => s + b.width, 0);

    if (airBefore > groundBefore) {
      const diff = airBefore - groundBefore;

      // 尝试从 air（长轨）左侧紧邻的 gap 削减
      const airLeftIdx = airIdx - 1;
      const airLeftBlock = airLeftIdx >= 0 ? wall.airBlocks[airLeftIdx] : null;
      const airLeftIsGap = airLeftBlock && airLeftBlock.items[0]?.category === 'gap';

      if (airLeftIsGap && airLeftBlock!.width > 0) {
        if (airLeftBlock!.width >= diff) {
          airLeftBlock!.width -= diff;
          if (airLeftBlock!.width === 0) {
            wall.airBlocks.splice(airLeftIdx, 1);
          }
        } else {
          const consumed = airLeftBlock!.width;
          wall.airBlocks.splice(airLeftIdx, 1);
          const remaining = diff - consumed;
          const gapBlock: SectionBlock = {
            id: uuid(),
            width: remaining,
            items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
          };
          // 削减后 airIdx 已减 1，groundIdx 不变
          wall.groundBlocks.splice(groundIdx, 0, gapBlock);
        }
      } else {
        // 左侧紧邻非 gap，无法削减，回退到在 ground 补 gap
        const gapBlock: SectionBlock = {
          id: uuid(),
          width: diff,
          items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
        };
        wall.groundBlocks.splice(groundIdx, 0, gapBlock);
      }
    } else if (groundBefore > airBefore) {
      const diff = groundBefore - airBefore;

      // 尝试从 ground（长轨）左侧紧邻的 gap 削减
      const groundLeftIdx = groundIdx - 1;
      const groundLeftBlock = groundLeftIdx >= 0 ? wall.groundBlocks[groundLeftIdx] : null;
      const groundLeftIsGap = groundLeftBlock && groundLeftBlock.items[0]?.category === 'gap';

      if (groundLeftIsGap && groundLeftBlock!.width > 0) {
        if (groundLeftBlock!.width >= diff) {
          groundLeftBlock!.width -= diff;
          if (groundLeftBlock!.width === 0) {
            wall.groundBlocks.splice(groundLeftIdx, 1);
          }
        } else {
          const consumed = groundLeftBlock!.width;
          wall.groundBlocks.splice(groundLeftIdx, 1);
          const remaining = diff - consumed;
          const gapBlock: SectionBlock = {
            id: uuid(),
            width: remaining,
            items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
          };
          wall.airBlocks.splice(airIdx, 0, gapBlock);
        }
      } else {
        // 左侧紧邻非 gap，无法削减，回退到在 air 补 gap
        const gapBlock: SectionBlock = {
          id: uuid(),
          width: diff,
          items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
        };
        wall.airBlocks.splice(airIdx, 0, gapBlock);
      }
    }
  }
}

// ==================================================================
//  推挤算法：在指定数组中按 blockId 找到块 A，将其距左位置推到 X
// ==================================================================

/** 推挤算法核心：移动 A 到距左 X，右侧块自然跟随。左移优先侵蚀 gap，不够则越过左侧非 gap 块。 */
function applyPushAlgorithm(blocks: SectionBlock[], blockId: string, X: number): void {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1) return;

  const A = blocks[idx];
  let oldX = 0;
  for (let i = 0; i < idx; i++) {
    oldX += blocks[i].width;
  }

  if (X === oldX) return;

  if (X < oldX) {
    const delta = oldX - X;
    const leftIdx = idx - 1;
    const leftBlock = leftIdx >= 0 ? blocks[leftIdx] : null;
    const leftIsGap = leftBlock && leftBlock.items[0]?.category === 'gap';

    if (leftIsGap && leftBlock!.width >= delta) {
      leftBlock!.width -= delta;
      if (leftBlock!.width === 0) {
        blocks.splice(leftIdx, 1);
      }
    } else if (leftIsGap && leftBlock!.width < delta && leftBlock!.width > 0) {
      const remaining = delta - leftBlock!.width;
      blocks.splice(leftIdx, 1);
      applyPushAlgorithm(blocks, blockId, oldX - leftBlock!.width - remaining);
    } else {
      let leftNeighborIdx = idx - 1;
      while (leftNeighborIdx >= 0 && blocks[leftNeighborIdx].items[0]?.category === 'gap') {
        leftNeighborIdx--;
      }

      if (leftNeighborIdx >= 0) {
        const B = blocks.splice(leftNeighborIdx, 1)[0];
        const newAIdx = leftNeighborIdx < idx ? idx - 1 : idx;
        blocks.splice(newAIdx + 1, 0, B);

        let gapStart = newAIdx - 1;
        while (gapStart >= 0 && blocks[gapStart].items[0]?.category === 'gap') {
          blocks.splice(gapStart, 1);
          gapStart--;
        }
        const currentAIdx = gapStart + 1;

        if (X > 0) {
          const gapBlock: SectionBlock = {
            id: uuid(),
            width: X,
            items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
          };
          blocks.splice(currentAIdx, 0, gapBlock);
        }
      }
    }
  } else {
    const delta = X - oldX;
    const leftGapIdx = idx - 1;
    if (leftGapIdx >= 0 && blocks[leftGapIdx].items[0]?.category === 'gap') {
      blocks[leftGapIdx].width += delta;
    } else {
      const gapBlock: SectionBlock = {
        id: uuid(),
        width: delta,
        items: [{ id: uuid(), category: 'gap', sku: 'gap' }],
      };
      blocks.splice(idx, 0, gapBlock);
    }
  }
}

// ==================================================================
//  全高物品双轨联动操作
// ==================================================================

/** 同时在 air 和 ground 轨道插入全高物品 */
function insertBothTracksImpl(wall: LayoutWall, itemTemplate: Omit<BlockItem, 'id'>): {
  airBlock: SectionBlock;
  groundBlock: SectionBlock;
} {
  const sharedItem: BlockItem = { ...itemTemplate, id: uuid() };
  const airBlock: SectionBlock = {
    id: uuid(),
    width: 0, // caller sets
    items: [sharedItem],
  };
  const groundBlock: SectionBlock = {
    id: uuid(),
    width: 0, // caller sets
    items: [{ ...sharedItem }],
  };
  return { airBlock, groundBlock };
}

// ==================================================================
//  Store 类型
// ==================================================================

interface LayoutStoreState {
  activeLayout: LayoutDocument | null;
  loading: boolean;
  error: string;

  // ---- SSE 识别事件回调（供 LayoutChatPanel / ImageUploadPanel 通信） ----
  /** 布局识别过程中产生的事件回调 */
  recognitionEventCallback: ((event: SSEEvent) => void) | null;
  /** 注册/取消注册事件回调 */
  setRecognitionEventCallback: (cb: ((event: SSEEvent) => void) | null) => void;
  /** 向当前注册的回调发送识别事件 */
  emitRecognitionEvent: (event: SSEEvent) => void;

  // ---- Layout 生命周期 ----
  /** 创建全新空布局 */
  newLayout: () => void;
  /** 从 JSON 字符串加载布局并设为激活 */
  loadLayout: (json: string) => void;
  /** 导出当前布局为 JSON 字符串 */
  getActiveLayoutJson: () => string | null;

  // ---- Wall CRUD ----
  addWall: (name: string, width: number) => string;
  removeWall: (wallId: string) => void;
  updateWall: (wallId: string, patch: Partial<LayoutWall>) => void;

  // ---- Block 操作（单轨） ----
  insertBlock: (wallId: string, track: TrackSpan, item: Omit<BlockItem, 'id'>, width: number, colorCode?: string) => string;
  deleteBlock: (wallId: string, track: TrackSpan, blockId: string, mode: 'static' | 'dynamic') => void;
  insertBlockAtPosition: (
    wallId: string,
    track: TrackSpan,
    item: Omit<BlockItem, 'id'>,
    width: number,
    distanceFromLeft: number,
    colorCode?: string,
  ) => string;
  updateBlockWidth: (wallId: string, track: TrackSpan, blockId: string, newWidth: number) => void;

  // ---- Block 操作（全高物品双轨联动） ----
  insertBothTracks: (wallId: string, item: Omit<BlockItem, 'id'>, width: number, colorCode?: string) => { airBlockId: string; groundBlockId: string };
  deleteBothTracks: (wallId: string, itemId: string, mode: 'static' | 'dynamic') => void;
  insertBothTracksAtPosition: (
    wallId: string,
    item: Omit<BlockItem, 'id'>,
    width: number,
    distanceFromLeft: number,
    colorCode?: string,
  ) => { airBlockId: string; groundBlockId: string };
  updateBlockWidthBothTracks: (wallId: string, itemId: string, newWidth: number) => void;

  // ---- Block 操作（多 item 叠放） ----
  insertBlockWithItems: (wallId: string, track: TrackSpan, items: Omit<BlockItem, 'id'>[], width: number, colorCode?: string) => string;
  insertBothTracksWithItems: (wallId: string, mainItem: Omit<BlockItem, 'id'>, stackedItems: Omit<BlockItem, 'id'>[], width: number, colorCode?: string) => { airBlockId: string; groundBlockId: string };
  removeStackedItem: (wallId: string, blockId: string, itemId: string) => void;
  /** 向已有 block 追加一个叠放吊柜 item（仅 air 轨有意义） */
  addStackedItem: (wallId: string, blockId: string, sku: string, height?: number) => void;
  /** 修改某个 item 的 SKU（按 itemId 查找，双轨块共享 id 会同步两轨） */
  updateItemSku: (wallId: string, itemId: string, newSku: string) => void;
  /** 修改某个 item 的 isVanity（按 itemId 查找，双轨块共享 id 会同步两轨） */
  updateItemVanity: (wallId: string, itemId: string, isVanity: boolean) => void;
  /** 修改某个 item 的高度（按 itemId 查找，双轨块共享 id 会同步两轨）。仅 air 轨物品有意义 */
  updateItemHeight: (wallId: string, itemId: string, height: number) => void;
  /** 修改某个 block 的颜色代码 */
  updateBlockColor: (wallId: string, track: TrackSpan, blockId: string, colorCode: string) => void;
  /** 修改双轨块的颜色代码（按 itemId 同步两轨） */
  updateBlockColorBothTracks: (wallId: string, itemId: string, colorCode: string) => void;

  // ---- Block 排序（拖拽用） ----
  reorderBlock: (wallId: string, track: TrackSpan, blockId: string, toIndex: number) => void;

  // ---- Block 精确位置编辑（推挤算法） ----
  setBlockPosition: (wallId: string, track: TrackSpan, blockId: string, newDistanceFromLeft: number) => void;

  // ---- 位置计算 ----
  computePositions: (blocks: SectionBlock[]) => PositionedBlock[];

  // ---- 辅助 ----
  getActiveLayout: () => LayoutDocument | null;
  isDualTrack: (category: BlockItemCategory) => boolean;
  isAirTrack: (category: BlockItemCategory) => boolean;
  isGroundTrack: (category: BlockItemCategory) => boolean;
}

// ==================================================================
//  Store 创建
// ==================================================================

/** 构造一个空白布局文档（供初始化与 newLayout 复用） */
function createEmptyLayout(): LayoutDocument {
  const id = uuid();
  const now = nowISO();
  return {
    id,
    walls: [],
    createdAt: now,
    updatedAt: now,
  };
}

export const useLayoutStore = create<LayoutStoreState>((set, get) => {
  const cached = loadFromStorage();
  // 初次进入若无缓存，自动创建空白布局并持久化，保证 activeLayout 永不为 null
  const initial = cached ?? createEmptyLayout();
  if (!cached) syncToStorage(initial);

  return {
    activeLayout: initial,
    loading: false,
    error: '',

    // ---- SSE 识别事件回调 ----
    recognitionEventCallback: null,
    setRecognitionEventCallback: (cb) => set({ recognitionEventCallback: cb }),
    emitRecognitionEvent: (event) => {
      const { recognitionEventCallback } = get();
      recognitionEventCallback?.(event);
    },

    // ---- Layout 生命周期 ----

    newLayout: () => {
      const newLayout = createEmptyLayout();
      set({ activeLayout: newLayout });
      syncToStorage(newLayout);
    },

    loadLayout: (json: string) => {
      const parsed = JSON.parse(json);
      if (!parsed || !parsed.id || !Array.isArray(parsed.walls)) {
        throw new Error('Invalid layout JSON: missing id or walls array');
      }
      set({ activeLayout: parsed as LayoutDocument });
      syncToStorage(parsed as LayoutDocument);
    },

    getActiveLayoutJson: () => {
      const { activeLayout } = get();
      return activeLayout ? JSON.stringify(activeLayout) : null;
    },

    // ---- Wall CRUD ----

    addWall: (name: string, width: number) => {
      const { activeLayout } = get();
      if (!activeLayout) return '';

      const num = activeLayout.walls.length + 1;
      const newWall: LayoutWall = {
        id: uuid(),
        name: name || `Wall ${num}`,
        width: width || 0,
        exposedLeft: false,
        exposedRight: false,
        exposedBack: false,
        airBlocks: [],
        groundBlocks: [],
        connectedWallIds: [],
        backToBackIslandIds: [],
      };
      const updated: LayoutDocument = {
        ...activeLayout,
        walls: [...activeLayout.walls, newWall],
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
      return newWall.id;
    },

    removeWall: (wallId: string) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.filter((w) => w.id !== wallId),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    updateWall: (wallId: string, patch: Partial<LayoutWall>) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) =>
          w.id === wallId ? { ...w, ...patch } : w,
        ),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    // ---- Block 操作（单轨） ----

    insertBlock: (wallId: string, track: TrackSpan, item: Omit<BlockItem, 'id'>, width: number, colorCode?: string) => {
      const { activeLayout } = get();
      if (!activeLayout) return '';

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return '';

      const newItem: BlockItem = { ...item, id: uuid() };
      const newBlock: SectionBlock = { id: uuid(), width, items: [newItem], colorCode: colorCode || undefined };

      const updatedWall = { ...ref.wall };
      const blocks = getTrackBlocks(updatedWall, track);
      insertBlocksAtEnd(blocks, [newBlock]);
      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
      return newBlock.id;
    },

    deleteBlock: (wallId: string, track: TrackSpan, blockId: string, mode: 'static' | 'dynamic') => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };
      const blocks = getTrackBlocks(updatedWall, track);
      const idx = blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      if (mode === 'static') {
        deleteBlockStatic(blocks, idx);
      } else {
        deleteBlockDynamic(blocks, idx);
      }
      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    insertBlockAtPosition: (
      wallId: string,
      track: TrackSpan,
      item: Omit<BlockItem, 'id'>,
      width: number,
      distanceFromLeft: number,
      colorCode?: string,
    ) => {
      const { activeLayout } = get();
      if (!activeLayout) return '';

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return '';

      const newItem: BlockItem = { ...item, id: uuid() };
      const newBlock: SectionBlock = { id: uuid(), width, items: [newItem], colorCode: colorCode || undefined };

      const updatedWall = { ...ref.wall };
      const blocks = getTrackBlocks(updatedWall, track);
      insertBlockAtPosition(blocks, newBlock, distanceFromLeft);
      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
      return newBlock.id;
    },

    updateBlockWidth: (wallId: string, track: TrackSpan, blockId: string, newWidth: number) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };
      const blocks = getTrackBlocks(updatedWall, track);
      const block = blocks.find((b) => b.id === blockId);
      if (block) {
        block.width = Math.max(0, newWidth);
      }
      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    // ---- Block 操作（全高物品双轨联动） ----

    insertBothTracks: (wallId: string, item: Omit<BlockItem, 'id'>, width: number, colorCode?: string) => {
      const { activeLayout } = get();
      if (!activeLayout) return { airBlockId: '', groundBlockId: '' };

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return { airBlockId: '', groundBlockId: '' };

      const sharedItem: BlockItem = { ...item, id: uuid() };
      const cc = colorCode || undefined;
      const airBlock: SectionBlock = { id: uuid(), width, items: [{ ...sharedItem }], colorCode: cc };
      const groundBlock: SectionBlock = { id: uuid(), width, items: [{ ...sharedItem }], colorCode: cc };

      const updatedWall = { ...ref.wall };
      insertBlocksAtEnd(updatedWall.airBlocks, [airBlock]);
      insertBlocksAtEnd(updatedWall.groundBlocks, [groundBlock]);
      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
      return { airBlockId: airBlock.id, groundBlockId: groundBlock.id };
    },

    deleteBothTracks: (wallId: string, itemId: string, mode: 'static' | 'dynamic') => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };

      const airMatches = findBlocksByItemId(updatedWall.airBlocks, itemId);
      const groundMatches = findBlocksByItemId(updatedWall.groundBlocks, itemId);

      const allAirIndices = airMatches.map((m) => m.index).sort((a, b) => b - a);
      const allGroundIndices = groundMatches.map((m) => m.index).sort((a, b) => b - a);

      for (const idx of allAirIndices) {
        if (mode === 'static') {
          deleteBlockStatic(updatedWall.airBlocks, idx);
        } else {
          deleteBlockDynamic(updatedWall.airBlocks, idx);
        }
      }
      for (const idx of allGroundIndices) {
        if (mode === 'static') {
          deleteBlockStatic(updatedWall.groundBlocks, idx);
        } else {
          deleteBlockDynamic(updatedWall.groundBlocks, idx);
        }
      }
      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    insertBothTracksAtPosition: (
      wallId: string,
      item: Omit<BlockItem, 'id'>,
      width: number,
      distanceFromLeft: number,
      colorCode?: string,
    ) => {
      const { activeLayout } = get();
      if (!activeLayout) return { airBlockId: '', groundBlockId: '' };

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return { airBlockId: '', groundBlockId: '' };

      const sharedItem: BlockItem = { ...item, id: uuid() };
      const cc = colorCode || undefined;
      const airBlock: SectionBlock = { id: uuid(), width, items: [{ ...sharedItem }], colorCode: cc };
      const groundBlock: SectionBlock = { id: uuid(), width, items: [{ ...sharedItem }], colorCode: cc };

      const updatedWall = { ...ref.wall };
      insertBlockAtPosition(updatedWall.airBlocks, airBlock, distanceFromLeft);
      insertBlockAtPosition(updatedWall.groundBlocks, groundBlock, distanceFromLeft);
      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
      return { airBlockId: airBlock.id, groundBlockId: groundBlock.id };
    },

    updateBlockWidthBothTracks: (wallId: string, itemId: string, newWidth: number) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };

      for (const block of updatedWall.airBlocks) {
        if (block.items.some((item) => item.id === itemId)) {
          block.width = Math.max(0, newWidth);
        }
      }
      for (const block of updatedWall.groundBlocks) {
        if (block.items.some((item) => item.id === itemId)) {
          block.width = Math.max(0, newWidth);
        }
      }
      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    // ---- Block 操作（多 item 叠放） ----

    insertBlockWithItems: (
      wallId: string,
      track: TrackSpan,
      items: Omit<BlockItem, 'id'>[],
      width: number,
      colorCode?: string,
    ) => {
      const { activeLayout } = get();
      if (!activeLayout) return '';

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return '';

      const newItems: BlockItem[] = items.map((it) => ({ ...it, id: uuid() }));
      const newBlock: SectionBlock = { id: uuid(), width, items: newItems, colorCode: colorCode || undefined };

      const updatedWall = { ...ref.wall };
      const blocks = getTrackBlocks(updatedWall, track);
      insertBlocksAtEnd(blocks, [newBlock]);
      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
      return newBlock.id;
    },

    insertBothTracksWithItems: (
      wallId: string,
      mainItem: Omit<BlockItem, 'id'>,
      stackedItems: Omit<BlockItem, 'id'>[],
      width: number,
      colorCode?: string,
    ) => {
      const { activeLayout } = get();
      if (!activeLayout) return { airBlockId: '', groundBlockId: '' };

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return { airBlockId: '', groundBlockId: '' };

      const sharedMainItem: BlockItem = { ...mainItem, id: uuid() };
      const airStacked: BlockItem[] = stackedItems.map((it) => ({ ...it, id: uuid() }));
      const cc = colorCode || undefined;

      const airBlock: SectionBlock = {
        id: uuid(),
        width,
        items: [{ ...sharedMainItem }, ...airStacked],
        colorCode: cc,
      };
      const groundBlock: SectionBlock = {
        id: uuid(),
        width,
        items: [{ ...sharedMainItem }],
        colorCode: cc,
      };

      const updatedWall = { ...ref.wall };
      insertBlocksAtEnd(updatedWall.airBlocks, [airBlock]);
      insertBlocksAtEnd(updatedWall.groundBlocks, [groundBlock]);
      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
      return { airBlockId: airBlock.id, groundBlockId: groundBlock.id };
    },

    removeStackedItem: (wallId: string, blockId: string, itemId: string) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };

      const airIdx = updatedWall.airBlocks.findIndex((b) => b.id === blockId);
      const groundIdx = updatedWall.groundBlocks.findIndex((b) => b.id === blockId);
      const blocks = airIdx !== -1 ? updatedWall.airBlocks : updatedWall.groundBlocks;
      const idx = airIdx !== -1 ? airIdx : groundIdx;
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.items.length <= 1) return;

      const filtered = block.items.filter((item) => item.id !== itemId);
      if (filtered.length === 0) return;
      block.items = filtered;

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    addStackedItem: (wallId: string, blockId: string, sku: string, height?: number) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };

      // 在 air / ground 中查找目标 block（叠放概念上仅 air 轨使用）
      const airIdx = updatedWall.airBlocks.findIndex((b) => b.id === blockId);
      const groundIdx = updatedWall.groundBlocks.findIndex((b) => b.id === blockId);
      const blocks = airIdx !== -1 ? updatedWall.airBlocks : updatedWall.groundBlocks;
      const idx = airIdx !== -1 ? airIdx : groundIdx;
      if (idx === -1) return;

      const block = blocks[idx];
      const trimmed = sku.trim();
      if (!trimmed) return;

      const newItem: BlockItem = { id: uuid(), category: 'wall_cabinet', sku: trimmed };
      if (height !== undefined && height > 0) newItem.height = height;
      block.items = [...block.items, newItem];

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    updateItemSku: (wallId: string, itemId: string, newSku: string) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };
      const trimmed = newSku.trim();

      // 双轨块共享 itemId，遍历两轨统一更新
      for (const block of updatedWall.airBlocks) {
        const item = block.items.find((it) => it.id === itemId);
        if (item) item.sku = trimmed;
      }
      for (const block of updatedWall.groundBlocks) {
        const item = block.items.find((it) => it.id === itemId);
        if (item) item.sku = trimmed;
      }

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    updateItemVanity: (wallId: string, itemId: string, isVanity: boolean) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };

      // vanity 只可能在地面
      for (const block of updatedWall.groundBlocks) {
        const item = block.items.find((it) => it.id === itemId);
        if (item && item.category === 'base_cabinet') item.isVanity = isVanity;
      }

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    updateItemHeight: (wallId: string, itemId: string, height: number) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };
      const h = Math.max(0, height);

      // 双轨块共享 itemId，遍历两轨统一更新
      for (const block of updatedWall.airBlocks) {
        const item = block.items.find((it) => it.id === itemId);
        if (item) item.height = h;
      }
      for (const block of updatedWall.groundBlocks) {
        const item = block.items.find((it) => it.id === itemId);
        if (item) item.height = h;
      }

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    updateBlockColor: (wallId: string, track: TrackSpan, blockId: string, colorCode: string) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };
      const blocks = getTrackBlocks(updatedWall, track);
      const block = blocks.find((b) => b.id === blockId);
      if (block) {
        block.colorCode = colorCode || undefined;
      }

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    updateBlockColorBothTracks: (wallId: string, itemId: string, colorCode: string) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };
      const cc = colorCode || undefined;

      // 双轨块共享 itemId，遍历两轨统一更新 colorCode
      for (const block of updatedWall.airBlocks) {
        if (block.items.some((item) => item.id === itemId)) {
          block.colorCode = cc;
        }
      }
      for (const block of updatedWall.groundBlocks) {
        if (block.items.some((item) => item.id === itemId)) {
          block.colorCode = cc;
        }
      }

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    // ---- Block 排序（拖拽用） ----

    reorderBlock: (wallId: string, track: TrackSpan, blockId: string, toIndex: number) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };
      const blocks = getTrackBlocks(updatedWall, track);
      const idx = blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      const block = blocks[idx];
      const movingIsDual = block.items.some((item) => isDualTrack(item.category));

      if (idx === toIndex) return;

      if (movingIsDual) {
        const itemId = block.items[0].id;

        // 计算主动轨 toIndex 对应的累积距左位置
        let targetPosition = 0;
        for (let i = 0; i < toIndex; i++) {
          targetPosition += blocks[i].width;
        }

        // 主动轨：按 toIndex 序号 splice
        const removed = blocks.splice(idx, 1)[0];
        let target = toIndex;
        if (target > idx) target--;
        target = Math.max(0, Math.min(target, blocks.length));
        blocks.splice(target, 0, removed);

        // 被动轨：用推挤算法将对应双轨块推到 targetPosition
        const passiveSpan: TrackSpan = track === 'air' ? 'ground' : 'air';
        const passiveBlocks = getTrackBlocks(updatedWall, passiveSpan);
        const passiveBlock = passiveBlocks.find(
          (b) => b.items.some((it) => it.id === itemId),
        );
        if (passiveBlock) {
          applyPushAlgorithm(passiveBlocks, passiveBlock.id, targetPosition);
        }
      } else {
        const removed = blocks.splice(idx, 1)[0];
        let target = toIndex;
        if (target > idx) target--;
        target = Math.max(0, Math.min(target, blocks.length));
        blocks.splice(target, 0, removed);
      }

      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    // ---- Block 精确位置编辑（推挤算法） ----

    setBlockPosition: (wallId: string, track: TrackSpan, blockId: string, newDistanceFromLeft: number) => {
      const { activeLayout } = get();
      if (!activeLayout) return;

      const ref = findWallInLayout(activeLayout, wallId);
      if (!ref) return;

      const updatedWall = { ...ref.wall };
      const blocks = getTrackBlocks(updatedWall, track);
      const block = blocks.find((b) => b.id === blockId);
      if (!block) return;

      const movingIsDual = block.items.some((item) => isDualTrack(item.category));

      if (movingIsDual) {
        const itemId = block.items[0].id;
        // 分别在 air 和 ground 两轨按 itemId 找块并执行推挤算法
        const airBlock = updatedWall.airBlocks.find((b) => b.items.some((it) => it.id === itemId));
        const groundBlock = updatedWall.groundBlocks.find((b) => b.items.some((it) => it.id === itemId));
        if (airBlock) applyPushAlgorithm(updatedWall.airBlocks, airBlock.id, newDistanceFromLeft);
        if (groundBlock) applyPushAlgorithm(updatedWall.groundBlocks, groundBlock.id, newDistanceFromLeft);
      } else {
        applyPushAlgorithm(blocks, blockId, newDistanceFromLeft);
      }

      // 自动拓宽墙体宽度以容纳超出部分
      const airTotal = updatedWall.airBlocks.reduce((s, b) => s + b.width, 0);
      const groundTotal = updatedWall.groundBlocks.reduce((s, b) => s + b.width, 0);
      const maxTotal = Math.max(airTotal, groundTotal);
      if (maxTotal > updatedWall.width) {
        updatedWall.width = maxTotal;
      }

      alignAirGround(updatedWall);

      const updated: LayoutDocument = {
        ...activeLayout,
        walls: activeLayout.walls.map((w) => (w.id === wallId ? updatedWall : w)),
        updatedAt: nowISO(),
      };
      set({ activeLayout: updated });
      syncToStorage(updated);
    },

    // ---- 位置计算 ----

    computePositions,

    // ---- 辅助 ----

    getActiveLayout: () => {
      return get().activeLayout;
    },

    isDualTrack,
    isAirTrack,
    isGroundTrack,
  };
});

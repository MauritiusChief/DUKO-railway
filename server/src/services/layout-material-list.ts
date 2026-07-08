/**
 * Layout Material List Generator —— 完整物料清单生成算法
 *
 * 根据 LayoutDocument 计算原始柜/电器 + 辅料（DWP/RRP + 侧板 + TK/QR/SM/CM 距料）。
 * 纯算法服务，不依赖 Express / 数据库，便于单元测试。
 *
 * 输出文本逐行 "{sku} x {quantity}"，可直接粘贴到主表解析页由既有解析器解析。
 *
 * 关键规则摘要：
 *  - 双轨物品（tall_cabinet / tall_appliance）同时出现在 airBlocks 与 groundBlocks，
 *    共享同一个 BlockItem.id，按 id 去重，避免重复计数。
 *  - connectedWallIds 不参与外露判定，外露仅由 exposedLeft/exposedRight/exposedBack 决定。
 *  - UNIPACK 颜色（02/04）无需侧板（工厂不生产该色 BEP/WEP），高柜侧改用 PNL3696Q 大板替代。
 *  - 缺色（colorCode 为空）不算 UNIPACK，侧板不带颜色前缀（如 BEP），但 DWP/RRP 框侧仍用 PNL3696Q。
 *  - tall cabinet 紧邻较矮柜（地柜/吊柜）时侧面外露，需补 PNL3696Q。
 */

import { UNIPACK_STYLE_CODES } from '../constants.js';
import type {
  LayoutDocument,
  LayoutWall,
  SectionBlock,
  BlockItem,
  BlockItemCategory,
} from '../types/layout.js';

// ==================================================================
//  常量
// ==================================================================

/** 距料单根长度（英寸），TK/QR/SM/CM 均按此向上取整 */
const MATERIAL_STICK_LENGTH = 96;
/** 地柜标准高度（英寸） */
const BASE_HEIGHT = 34.5;
/** 地柜标准进深 */
const BASE_DEPTH = 24;
/** vanity 地柜进深 */
const VANITY_DEPTH = 21;
/** 吊柜标准进深 */
const WALL_DEPTH = 12;
/** 高柜 / 高电器进深 */
const TALL_DEPTH = 24;

/** UNIPACK 颜色集合（该颜色无需 BEP/WEP 等侧板，工厂不生产） */
const UNIPACK_SET = new Set(UNIPACK_STYLE_CODES);

// ==================================================================
//  响应类型
// ==================================================================

export interface MaterialListItem {
  sku: string;
  quantity: number;
}

export interface MaterialListLengthDetail {
  sku: string;
  length: number;
}

export interface MaterialListResult {
  text: string;
  items: MaterialListItem[];
  /** 各距料 SKU 的原始长度（ceil 前），直接来自 lengthBySku */
  lengthDetails: MaterialListLengthDetail[];
  warnings: string[];
}

// ==================================================================
//  分类辅助
// ==================================================================

/** 大开口类（gap / stuffed_gap）—— 会让相邻物体侧面外露 */
const GAP_LIKE: ReadonlySet<BlockItemCategory> = new Set([
  'gap',
  'stuffed_gap',
]);

/** 无需颜色信息的分类 —— 清单生成时不做缺色警告 */
const NO_COLOR_CATEGORIES: ReadonlySet<BlockItemCategory> = new Set([
  'gap',
  'stuffed_gap',
  'tall_appliance',
  'base_appliance_need_top',
  'base_appliance_without_top',
]);

function isGapLike(cat: BlockItemCategory): boolean {
  return GAP_LIKE.has(cat);
}
function isAppliance(cat: BlockItemCategory): boolean {
  return cat === 'base_appliance_need_top' || cat === 'tall_appliance' || cat === 'base_appliance_without_top'
}
/** 两侧均遮挡不住的物体（gap-like + gaplike_item），用于外露判定 */
function isNonBlocking(cat: BlockItemCategory): boolean {
  return GAP_LIKE.has(cat) || cat === 'gaplike_item';
}
function isBaseCabinet(cat: BlockItemCategory): boolean {
  return cat === 'base_cabinet';
}
function isWallCabinet(cat: BlockItemCategory): boolean {
  return cat === 'wall_cabinet';
}
function isTallCabinet(cat: BlockItemCategory): boolean {
  return cat === 'tall_cabinet';
}
function isTallAppliance(cat: BlockItemCategory): boolean {
  return cat === 'tall_appliance';
}
function isBaseApplianceNeedTop(cat: BlockItemCategory): boolean {
  return cat === 'base_appliance_need_top';
}
function isFiller(cat: BlockItemCategory): boolean {
  return cat === 'filler';
}
/** 占据地面轨的物体（用于邻接遮挡判断；base_appliance_without_top 仅遮挡不产辅料） */
function isGroundObject(cat: BlockItemCategory): boolean {
  return (
    cat === 'base_cabinet' ||
    cat === 'tall_cabinet' ||
    cat === 'tall_appliance' ||
    cat === 'base_appliance_need_top' ||
    cat === 'base_appliance_without_top' ||
    cat === 'gaplike_item' ||
    cat === 'filler'
  );
}
/** tall 物体（高柜 / 高电器）—— 跨 air + ground 双轨，用于"整侧外露"简化规则 */
function isTallObject(cat: BlockItemCategory): boolean {
  return cat === 'tall_cabinet' || cat === 'tall_appliance';
}
/** 两类电器：tall_appliance / base_appliance_need_top —— filler 紧邻时需清除 */
function isFramedAppliance(cat: BlockItemCategory): boolean {
  return cat === 'tall_appliance' || cat === 'base_appliance_need_top';
}

// ==================================================================
//  Block 辅助
// ==================================================================

/** 取 block 的主分类（items[0]） */
function blockCategory(block: SectionBlock): BlockItemCategory {
  return block.items[0]?.category ?? 'gap';
}

/** block 是否为 vanity 地柜 */
function isVanityBlock(block: SectionBlock): boolean {
  return block.items[0]?.isVanity === true;
}
function isAllVanityBlock(posBlocks: PosBlock[]): boolean {
  return posBlocks.every(posBlock => isVanityBlock(posBlock.block))
}

/** block 是否含 tall 物体（高柜/高电器）—— 用于识别叠放吊柜场景 */
function hasTallItem(block: SectionBlock): boolean {
  return block.items.some(
    (it) => it.category === 'tall_cabinet' || it.category === 'tall_appliance',
  );
}

/** 取 block 的 colorCode（空字符串视为缺色 → undefined） */
function blockColor(block: SectionBlock): string | undefined {
  const c = block.colorCode;
  return c && c.length > 0 ? c : undefined;
}

/** 颜色前缀拼接：有颜色则 `${color}${shape}`，无颜色则仅 shape */
function withColor(colorCode: string | undefined, shape: string): string {
  return colorCode ? `${colorCode}${shape}` : shape;
}

/** 是否 UNIPACK 颜色 */
function isUnicolor(colorCode: string | undefined): boolean {
  return !!colorCode && UNIPACK_SET.has(colorCode);
}

/**
 * 取物品高度，缺失则用默认值并写 warning。
 * @param def 默认高度（吊柜 30 / 叠放吊柜 15 / 高柜·高电器 96）
 */
function heightOrDefault(
  item: BlockItem,
  def: number,
  warnings: string[],
  context: string,
): number {
  if (item.height != null && item.height > 0) return item.height;
  warnings.push(`${context} 缺少高度，默认 ${def}"`);
  return def;
}

// ==================================================================
//  几何定位
// ==================================================================

interface PosBlock {
  block: SectionBlock;
  start: number;
  end: number;
  cat: BlockItemCategory;
}

/** 把 SectionBlock[] 转成带起止位置的 PosBlock[]（位置由左侧块累积宽度推算） */
function positionBlocks(blocks: SectionBlock[]): PosBlock[] {
  let cursor = 0;
  const result: PosBlock[] = [];
  for (const block of blocks) {
    const start = cursor;
    const end = cursor + block.width;
    result.push({ block, start, end, cat: blockCategory(block) });
    cursor = end;
  }
  return result;
}

// ==================================================================
//  外露判定
// ==================================================================

type Side = 'left' | 'right';

/** 是否贴墙边缘（start===0 或 end===wall.width） */
function atEdge(pos: PosBlock, wall: LayoutWall, side: Side): boolean {
  return side === 'left' ? pos.start === 0 : pos.end === wall.width;
}

/** 把紧邻 filler 也算作自己的一部分的情况下，是否贴墙边缘（最远的紧邻 filler, start===0 或 end===wall.width） */
function atEdgeAbsorbFiller(
  pos: PosBlock,
  blocks: PosBlock[],
  wall: LayoutWall,
  side: Side,
): boolean {
  let current = pos;
  while (true) {
    const neighbor = getNeighbor(current, blocks, side);
    if (!neighbor || neighbor.cat !== 'filler') break;
    current = neighbor;
  }
  return side === 'left'
    ? current.start === 0
    : current.end === wall.width;
}

/** 墙边缘外露标志（exposedLeft / exposedRight） */
function edgeFlag(wall: LayoutWall, side: Side): boolean {
  return side === 'left' ? wall.exposedLeft : wall.exposedRight;
}

/** 取指定方向的相邻 PosBlock */
function getNeighbor(
  pos: PosBlock,
  blocks: PosBlock[],
  side: Side,
): PosBlock | undefined {
  const i = blocks.indexOf(pos);
  if (i < 0) return undefined;
  return side === 'left'
    ? i > 0
      ? blocks[i - 1]
      : undefined
    : i < blocks.length - 1
      ? blocks[i + 1]
      : undefined;
}

/**
 * 获取指定方向非 filler 的相邻 PosBlock, 用于侧板和 SM 判断逻辑
 */
function getNonFillerNeighbor(
  pos: PosBlock,
  blocks: PosBlock[],
  side: Side,
): PosBlock | undefined {
  const i = blocks.indexOf(pos);
  if (i < 0) return undefined;

  let j = side === 'left' ? i - 1 : i + 1;
  while (j >= 0 && j < blocks.length) {
    const neighbor = blocks[j];
    if (neighbor.cat !== 'filler') return neighbor;
    j += side === 'left' ? -1 : 1;
  }

  return undefined;
}

/**
 * DWP/RRP 框的侧边外露的情况（仅边缘 + 两侧均遮挡不住的邻居）—— 用于 DWP/RRP 框侧板、QR/CM 侧面、DWP 框 SM。
 * 柜邻电器、柜邻柜均不算外露。gaplike_item 两侧也遮挡不住。filler 需要被跳过，看其更外侧是否有邻居
 */
function frameSideExposed(
  pos: PosBlock,
  blocks: PosBlock[],
  wall: LayoutWall,
  side: Side,
): boolean {
  if (atEdge(pos, wall, side)) return edgeFlag(wall, side);
  const neighbor = getNonFillerNeighbor(pos, blocks, side);
  return !!neighbor && isNonBlocking(neighbor.cat);
}

/**
 * 柜体侧板外露情形：
 * - 边缘
 * - 大开口
 * - vanity 邻接
 * - tall 柜紧邻较矮柜
 * 
 * 检测相邻关系时，直接令 filler 透明化
 */
function cabinetSideExposed(
  cat: BlockItemCategory,
  pos: PosBlock,
  blocks: PosBlock[],
  wall: LayoutWall,
  side: Side,
): boolean {
  // 边缘 → 根据墙本身暴露情况
  if (atEdgeAbsorbFiller(pos, blocks, wall, side)) return edgeFlag(wall, side);
  // 大开口 → 略过 filler, 看有没有真正有效的邻居
  const neighbor = getNonFillerNeighbor(pos, blocks, side);
  if (!neighbor) return false;
  const ncat = neighbor.cat;
  if (isNonBlocking(ncat)) return true;
  // vanity 邻接：普通地柜紧邻 vanity 地柜 → 普通地柜侧外露（需 BEP）
  if (
    cat === 'base_cabinet' &&
    !isVanityBlock(pos.block) &&
    ncat === 'base_cabinet' &&
    isVanityBlock(neighbor.block)
  ) {
    return true;
  }
  // tall 柜紧邻较矮柜（地柜/吊柜）→ tall 柜侧外露（需 PNL3696Q）
  if (cat === 'tall_cabinet' && (ncat === 'base_cabinet' || ncat === 'wall_cabinet')) {
    return true;
  }
  return false;
}

/**
 * SM 侧面外露（不含 vanity）。
 * - 边缘
 * - 大开口
 * - tall 柜紧邻较矮柜
 * 
 * 用于 SM 距料长度累计。
 */
function smSideExposed(
  cat: BlockItemCategory,
  pos: PosBlock,
  blocks: PosBlock[],
  wall: LayoutWall,
  side: Side,
): boolean {
  // 边缘 → 根据墙本身暴露情况
  if (atEdgeAbsorbFiller(pos, blocks, wall, side)) return edgeFlag(wall, side);
  // 大开口 → 略过 filler, 看有没有真正有效的邻居
  const neighbor = getNonFillerNeighbor(pos, blocks, side);
  if (!neighbor) return false;
  const ncat = neighbor.cat;
  if (isNonBlocking(ncat)) return true;
  // tall 物体紧邻较矮柜 → 整侧外露（简化规则，加一整段物体高度的 SM）
  if (
    isTallObject(cat) &&
    (neighbor.cat === 'base_cabinet' || neighbor.cat === 'wall_cabinet')
  ) {
    return true;
  }
  return false;
}

// ==================================================================
//  累加器
// ==================================================================

interface Accumulator {
  /** 离散物料（原始柜/电器 + DWP/RRP + 侧板 + ceil 后的距料） */
  itemQuantityBySku: Map<string, number>;
  /** 距料原始长度（按含色 SKU 归集，ceil 前的值） */
  lengthBySku: Map<string, number>;
  /** 警告信息 */
  warnings: string[];
  /** 已计入原始行的 item id（去重双轨物品） */
  seenItemIds: Set<string>;
}

function addDiscrete(acc: Accumulator, sku: string, qty: number): void {
  if (qty <= 0) return;
  acc.itemQuantityBySku.set(sku, (acc.itemQuantityBySku.get(sku) ?? 0) + qty);
}

/** 累加距料原始长度到对应 SKU */
function addLength(acc: Accumulator, sku: string, len: number): void {
  if (len <= 0) return;
  acc.lengthBySku.set(sku, (acc.lengthBySku.get(sku) ?? 0) + len);
}

function warnMissingColor(acc: Accumulator, wallName: string, idx: number, block?: SectionBlock): void {
  // 无需颜色的分类不报警
  const category = block?.items[0].category
  const sku = block?.items[0].sku
  if (category && NO_COLOR_CATEGORIES.has(category)) return;
  const info = !category || isGroundObject(category) ? `墙"${wallName}"地面[${idx + 1}]${sku}缺少颜色信息` : `墙"${wallName}"空中[${idx + 1}]${sku}缺少颜色信息`
  acc.warnings.push(info);
}

// ==================================================================
//  原始柜/电器行
// ==================================================================

/** 遍历所有墙的所有 block 所有 item，按 id 去重，跳过 gap-like（含 stuffed_gap），聚合 sku */
function collectOriginalItems(layout: LayoutDocument, acc: Accumulator): void {
  for (const wall of layout.walls) {
    for (const block of [...wall.airBlocks, ...wall.groundBlocks]) {
      for (const item of block.items) {
        // gap / stuffed_gap 不作为产品行
        if (isGapLike(item.category)) continue;
        // 电器也不是产品
        if (isAppliance(item.category)) continue
        // 双轨物品（tall_cabinet / tall_appliance）按 id 去重
        if (acc.seenItemIds.has(item.id)) continue;
        acc.seenItemIds.add(item.id);
        addDiscrete(acc, item.sku, 1);
      }
    }
  }
}

// ==================================================================
//  DWP（base_appliance_need_top 的框料）
// ==================================================================

interface TallApplianceInfo {
  /** air 轨中的 posBlock（含叠放吊柜） */
  airPos: PosBlock | undefined;
  /** ground 轨中的 posBlock */
  groundPos: PosBlock | undefined;
  /** 是否有叠放吊柜（决定是否需要 RRP） */
  hasStacked: boolean;
  /** 高电器本体高度 */
  applianceHeight: number;
  /** 叠放吊柜高度之和 */
  stackedHeight: number;
  /** 完整高度（本体 + 叠放） */
  fullHeight: number;
}

/**
 * 处理 DWP 框料
 * DWP 默认左右各 1 片（共 2）；贴墙边缘且该侧不外露时省去该侧 DWP。
 */
function processDwp(
  wall: LayoutWall,
  ground: PosBlock[],
  acc: Accumulator,
): void {
  for (const pos of ground) {
    if (!isBaseApplianceNeedTop(pos.cat)) continue;
    const color = blockColor(pos.block);

    // 左右两侧是否需要 DWP（贴墙且不外露则省去）
    const leftOmit = atEdge(pos, wall, 'left') && !wall.exposedLeft;
    const rightOmit = atEdge(pos, wall, 'right') && !wall.exposedRight;
    const dwpCount = (leftOmit ? 0 : 1) + (rightOmit ? 0 : 1);
    addDiscrete(acc, withColor(color, 'DWP'), dwpCount);

    // 框侧外露 → 加侧板 + SM + QR（仅 !exposedBack 时才加 SM）
    for (const side of ['left', 'right'] as Side[]) {
      const omitted = side === 'left' ? leftOmit : rightOmit;
      if (omitted) continue;
      if (!frameSideExposed(pos, ground, wall, side)) continue;

      // 框侧板：UNIPACK → PNL3696Q；非 UNIPACK 有色或缺色 → BEP
      const panelSku = isUnicolor(color)
        ? withColor(color, 'PNL3696Q')
        : withColor(color, 'BEP');
      addDiscrete(acc, panelSku, 1);

      // 框侧 SM（地柜高度，仅背墙不外露时）
      if (!wall.exposedBack) {
        addLength(acc, withColor(color, 'SM'), BASE_HEIGHT);
      }

      // 框侧 QR（进深，appliance 正背始终不算 QR）
      addLength(acc, withColor(color, 'QR'), BASE_DEPTH);
    }
  }
}

/**
 * 收集高电器信息（air/ground 双轨定位 + 叠放吊柜检测 + 高度计算）。
 */
function collectTallAppliances(
  wall: LayoutWall,
  air: PosBlock[],
  ground: PosBlock[],
  acc: Accumulator,
): TallApplianceInfo[] {
  const infos: TallApplianceInfo[] = [];
  const seen = new Set<string>();
  for (const pos of air) {
    if (!isTallAppliance(pos.cat)) continue;
    const item = pos.block.items[0];
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);

    // 叠放吊柜 = 同 air block 中除本体外的 wall_cabinet
    const stacked = pos.block.items.filter(
      (it) => it.category === 'wall_cabinet' && it.id !== item.id,
    );
    const hasStacked = stacked.length > 0;
    const applianceHeight = heightOrDefault(
      item,
      96,
      acc.warnings,
      `高电器 ${item.sku}`,
    );
    const stackedHeight = stacked.reduce(
      (s, it) => s + heightOrDefault(it, 15, acc.warnings, `叠放吊柜 ${it.sku}`),
      0,
    );

    // ground 轨定位（与 air 对齐，用于边缘/邻接判断）
    const groundPos = ground.find((g) =>
      g.block.items.some((it) => it.id === item.id),
    );

    infos.push({
      airPos: pos,
      groundPos,
      hasStacked,
      applianceHeight,
      stackedHeight,
      fullHeight: applianceHeight + stackedHeight,
    });
  }
  return infos;
}

/**
 * 处理 RRP 框料及其框侧板 / 框侧 SM / 框侧 QR / CM。
 * 仅当高电器上方有叠放吊柜时才需要 RRP。
 */
function processRrp(
  wall: LayoutWall,
  air: PosBlock[],
  ground: PosBlock[],
  tallApps: TallApplianceInfo[],
  acc: Accumulator,
): void {
  for (const info of tallApps) {
    if (!info.hasStacked) continue; // 无叠放 → 无 RRP
    const pos = info.airPos!;
    const color = blockColor(pos.block);

    // 左右两侧是否需要 RRP
    const leftOmit = atEdge(pos, wall, 'left') && !wall.exposedLeft;
    const rightOmit = atEdge(pos, wall, 'right') && !wall.exposedRight;
    const rrpCount = (leftOmit ? 0 : 1) + (rightOmit ? 0 : 1);
    addDiscrete(acc, withColor(color, 'RRP'), rrpCount);

    // 框侧外露（air ∪ ground 双轨）→ 加侧板 + SM + QR
    for (const side of ['left', 'right'] as Side[]) {
      const omitted = side === 'left' ? leftOmit : rightOmit;
      if (omitted) continue;
      // 框侧板：仅边缘/大开口外露（柜邻不算），双轨取并集
      const sideExposed =
        (info.airPos && frameSideExposed(info.airPos, air, wall, side)) ||
        (info.groundPos && frameSideExposed(info.groundPos, ground, wall, side));
      if (!sideExposed) continue;

      // RRP 框侧板始终用 PNL3696Q
      addDiscrete(acc, withColor(color, 'PNL3696Q'), 1);

      // 框侧 SM（完整高度，仅背墙不外露时）
      if (!wall.exposedBack) {
        addLength(acc, withColor(color, 'SM'), info.fullHeight);
      }

      // 框侧 QR（进深）
      addLength(acc, withColor(color, 'QR'), TALL_DEPTH);
    }

    // CM（高电器 + 叠放 = air 物体，进深 24）
    processCmForAirBlock(pos, air, wall, TALL_DEPTH, color, acc);
  }
}

// ==================================================================
//  侧板美化（BEP / VEP / WEP / PNL3696Q）
// ==================================================================

/**
 * 处理柜体侧板。
 * - 地柜（非 vanity）→ BEP；vanity 地柜 → VEP
 * - 吊柜 → WEP
 * - 高柜 → PNL3696Q
 * - UNIPACK 颜色跳过柜体侧板（框侧板另算）
 * - 叠放吊柜（与 tall 物体同 block）不单独算 WEP，由 tall 物体的 PNL3696Q 覆盖
 */
function processSidePanels(
  wall: LayoutWall,
  air: PosBlock[],
  ground: PosBlock[],
  tallApps: TallApplianceInfo[],
  acc: Accumulator,
): void {
  // ground 轨：地柜 / 高柜
  for (const pos of ground) {
    const cat = pos.cat;
    if (!isBaseCabinet(cat) && !isTallCabinet(cat)) continue;
    const color = blockColor(pos.block);
    // UNIPACK 颜色跳过柜体侧板
    if (isUnicolor(color)) continue;

    const vanity = isVanityBlock(pos.block);
    // 侧板形状
    const shape = isTallCabinet(cat)
      ? 'PNL3696Q'
      : vanity
        ? 'VEP'
        : 'BEP';

    // 高柜需双轨取并集判断外露；地柜仅看 ground 轨
    let leftExposed: boolean;
    let rightExposed: boolean;
    if (isTallCabinet(cat)) {
      const airPos = air.find((a) =>
        a.block.items.some((it) => it.id === pos.block.items[0]?.id),
      );
      leftExposed = tallSidePanelExposed(cat, airPos, pos, air, ground, wall, 'left');
      rightExposed = tallSidePanelExposed(cat, airPos, pos, air, ground, wall, 'right');
    } else {
      leftExposed = cabinetSideExposed(cat, pos, ground, wall, 'left');
      rightExposed = cabinetSideExposed(cat, pos, ground, wall, 'right');
    }

    let qty = 0;
    if (leftExposed) qty++;
    if (rightExposed) qty++;
    if (qty > 0) addDiscrete(acc, withColor(color, shape), qty);
  }

  // air 轨：吊柜（独立 block，非叠放）
  for (const pos of air) {
    if (!isWallCabinet(pos.cat)) continue;
    // 叠放吊柜（与 tall 物体同 block）跳过，由 tall 物体侧板覆盖
    if (hasTallItem(pos.block)) continue;
    const color = blockColor(pos.block);
    if (isUnicolor(color)) continue;

    const leftExposed = cabinetSideExposed(pos.cat, pos, air, wall, 'left');
    const rightExposed = cabinetSideExposed(pos.cat, pos, air, wall, 'right');
    let qty = 0;
    if (leftExposed) qty++;
    if (rightExposed) qty++;
    if (qty > 0) addDiscrete(acc, withColor(color, 'WEP'), qty);
  }
}

/** tall 柜侧板外露 = air 轨 ∪ ground 轨 */
function tallSidePanelExposed(
  cat: BlockItemCategory,
  airPos: PosBlock | undefined,
  groundPos: PosBlock,
  air: PosBlock[],
  ground: PosBlock[],
  wall: LayoutWall,
  side: Side,
): boolean {
  if (airPos && cabinetSideExposed(cat, airPos, air, wall, side)) return true;
  return cabinetSideExposed(cat, groundPos, ground, wall, side);
}

// ==================================================================
//  TK（踢脚线，覆盖地柜 + 高柜的正面宽度）
// ==================================================================

function processTk(wall: LayoutWall, ground: PosBlock[], acc: Accumulator): void {
  for (const pos of ground) {
    // 地柜 + 高柜 + filler 计入；电器不计入
    if (!isBaseCabinet(pos.cat) && !isTallCabinet(pos.cat) && !isFiller(pos.cat)) continue;
    const color = blockColor(pos.block);
    addLength(acc, withColor(color, 'TK'), pos.block.width);
  }
}

// ==================================================================
//  QR（地脚线，覆盖地面物体与地板的接缝周长）
// ==================================================================

/**
 * QR 规则：
 * - 地柜 / 高柜：正面按宽、背面按宽（exposedBack 时）、侧面按进深（外露时）
 * - 电器：正背始终不计；仅框侧（DWP/RRP）外露时按进深计（在 processDwp/processRrp 中累计）
 * - vanity 进深 21，其余地柜/高柜/电器进深 24
 */
function processQr(wall: LayoutWall, ground: PosBlock[], acc: Accumulator): void {
  for (const pos of ground) {
    const cat = pos.cat;
    // 仅地柜 / 高柜参与（电器框侧 QR 在 DWP/RRP 处理中累计）
    if (!isBaseCabinet(cat) && !isTallCabinet(cat) && !isFiller(cat)) continue;
    const color = blockColor(pos.block);
    const depth = isAllVanityBlock(ground) ? VANITY_DEPTH : BASE_DEPTH;

    // 正面始终计入
    addLength(acc, withColor(color, 'QR'), pos.block.width);
    // 背面：exposedBack 时计入
    if (wall.exposedBack) {
      addLength(acc, withColor(color, 'QR'), pos.block.width);
    }
    // 侧面：外露时按进深计入
    // 边缘的情况，由于常规柜子会越过 filler 查看边缘情况，因此 filler 需要跳过
    if (!isFiller(cat) && atEdgeAbsorbFiller(pos, ground, wall, 'right') && edgeFlag(wall, 'right')) {
      addLength(acc, withColor(color, 'QR'), depth);
    }
    if (!isFiller(cat) && atEdgeAbsorbFiller(pos, ground, wall, 'left') && edgeFlag(wall, 'left')) {
      addLength(acc, withColor(color, 'QR'), depth);
    }
    // 邻居遮挡不住的情况
    const rightNeighbor = getNonFillerNeighbor(pos, ground, 'right')
    if (rightNeighbor && isNonBlocking(rightNeighbor.cat)) {
      addLength(acc, withColor(color, 'QR'), depth);
    }
    const leftNeighbor = getNonFillerNeighbor(pos, ground, 'left')
    if (leftNeighbor && isNonBlocking(leftNeighbor.cat)) {
      addLength(acc, withColor(color, 'QR'), depth);
    }
  }
}

// ==================================================================
//  SM（侧封板，覆盖物体侧面与墙的竖向接缝）
// ==================================================================

/**
 * SM 规则（仅 exposedBack === false 时计算）：
 * - 地柜：34.5；吊柜：item.height；高柜：item.height（双轨取并集）
 * - 高电器 + 叠放：完整高度（本体 + 叠放），叠放吊柜不另算
 * - 高电器无叠放：无 RRP，自身及邻居均无需 SM
 * - DWP/RRP 框侧：在 processDwp/processRrp 中累计
 * - tall 物体紧邻较矮柜 → 整侧外露，加一整段物体高度
 */
function processSm(
  wall: LayoutWall,
  air: PosBlock[],
  ground: PosBlock[],
  tallApps: TallApplianceInfo[],
  acc: Accumulator,
): void {
  // 已处理的高电器 item id（避免在 air 循环中重复）
  const tallAppIds = new Set(
    tallApps.map((t) => t.airPos?.block.items[0]?.id).filter(Boolean) as string[],
  );

  // ground 轨：地柜
  for (const pos of ground) {
    if (!isBaseCabinet(pos.cat)) continue;
    const color = blockColor(pos.block);
    const h = BASE_HEIGHT;
    if (smSideExposed(pos.cat, pos, ground, wall, 'left')) {
      addLength(acc, withColor(color, 'SM'), h);
    }
    if (smSideExposed(pos.cat, pos, ground, wall, 'right')) {
      addLength(acc, withColor(color, 'SM'), h);
    }
  }

  // air 轨：吊柜（独立）+ 高柜 + 高电器（含叠放）
  for (const pos of air) {
    const cat = pos.cat;
    const item = pos.block.items[0];
    if (!item) continue;

    // 高电器在此处理（含叠放的 SM；无叠放则跳过）
    if (isTallAppliance(cat)) {
      if (tallAppIds.has(item.id)) {
        tallAppIds.delete(item.id); // 标记已处理
      }
      continue; // 高电器的 SM 已在 processRrp 中累计
    }

    // 吊柜（独立，非叠放）
    if (isWallCabinet(cat) && !hasTallItem(pos.block)) {
      const color = blockColor(pos.block);
      const h = heightOrDefault(item, 30, acc.warnings, `吊柜 ${item.sku}`);
      if (smSideExposed(cat, pos, air, wall, 'left')) {
        addLength(acc, withColor(color, 'SM'), h);
      }
      if (smSideExposed(cat, pos, air, wall, 'right')) {
        addLength(acc, withColor(color, 'SM'), h);
      }
      continue;
    }

    // 高柜（双轨，取 air 轨高度，双轨取并集判断外露）
    if (isTallCabinet(cat)) {
      const color = blockColor(pos.block);
      const h = heightOrDefault(item, 96, acc.warnings, `高柜 ${item.sku}`);
      const groundPos = ground.find((g) =>
        g.block.items.some((it) => it.id === item.id),
      );
      const leftExposed =
        smSideExposed(cat, pos, air, wall, 'left') ||
        (groundPos && smSideExposed(cat, groundPos, ground, wall, 'left'));
      const rightExposed =
        smSideExposed(cat, pos, air, wall, 'right') ||
        (groundPos && smSideExposed(cat, groundPos, ground, wall, 'right'));
      if (leftExposed) addLength(acc, withColor(color, 'SM'), h);
      if (rightExposed) addLength(acc, withColor(color, 'SM'), h);
      continue;
    }
  }
}

// ==================================================================
//  CM（顶线，覆盖空中物体与天花板的接缝周长）
// ==================================================================

/**
 * CM 规则（空中版 QR）：
 * - 吊柜（独立）：进深 12
 * - 叠放吊柜（与 tall 同 block）：不单独算，由 tall 物体覆盖
 * - 高柜：进深 24
 * - 高电器 + 叠放：进深 24（在 processRrp 中处理）
 * - 正面按宽、背面按宽（exposedBack 时）、侧面按进深（外露时）
 */
function processCm(
  wall: LayoutWall,
  air: PosBlock[],
  tallApps: TallApplianceInfo[],
  acc: Accumulator,
): void {
  const tallAppIds = new Set(
    tallApps.map((t) => t.airPos?.block.items[0]?.id).filter(Boolean) as string[],
  );

  for (const pos of air) {
    const cat = pos.cat;
    const item = pos.block.items[0];
    if (!item) continue;

    // 高电器已在 processRrp 中处理
    if (isTallAppliance(cat)) continue;

    // 吊柜（独立，非叠放）
    if (isWallCabinet(cat) && !hasTallItem(pos.block)) {
      const color = blockColor(pos.block);
      processCmForAirBlock(pos, air, wall, WALL_DEPTH, color, acc);
      continue;
    }

    // 高柜
    if (isTallCabinet(cat)) {
      const color = blockColor(pos.block);
      processCmForAirBlock(pos, air, wall, TALL_DEPTH, color, acc);
      continue;
    }
  }
}

/**
 * 单个 air block 的 CM 周长累计。
 * 正面按宽、背面按宽（exposedBack 时）、侧面按进深（外露时）。
 */
function processCmForAirBlock(
  pos: PosBlock,
  air: PosBlock[],
  wall: LayoutWall,
  depth: number,
  color: string | undefined,
  acc: Accumulator,
): void {
  // 正面始终计入
  addLength(acc, withColor(color, 'CM'), pos.block.width);
  // 背面：exposedBack 时计入
  if (wall.exposedBack) {
    addLength(acc, withColor(color, 'CM'), pos.block.width);
  }
  // 侧面：外露时按进深计入（QR 式：仅边缘 + 大开口；柜邻柜不算外露）
  if (frameSideExposed(pos, air, wall, 'left')) {
    addLength(acc, withColor(color, 'CM'), depth);
  }
  if (frameSideExposed(pos, air, wall, 'right')) {
    addLength(acc, withColor(color, 'CM'), depth);
  }
}

// ==================================================================
//  排序
// ==================================================================

/** 去掉颜色前缀（前导数字）取物料形状 */
function shapeOf(sku: string): string {
  return sku.replace(/^\d+/, '');
}

/** 排序分组：0 原始柜/电器 → 1 DWP/RRP → 2 侧板 → 3 距料 */
function groupOf(sku: string): number {
  const shape = shapeOf(sku);
  if (shape === 'DWP' || shape === 'RRP') return 1;
  if (shape === 'BEP' || shape === 'WEP' || shape === 'VEP' || shape === 'PNL3696Q')
    return 2;
  if (shape === 'TK' || shape === 'QR' || shape === 'SM' || shape === 'CM') return 3;
  return 0;
}

// ==================================================================
//  填充器清除 —— 紧邻高电器/需台面电器的 filler 自动清除
// ==================================================================

/**
 * 对于紧邻 tall_appliance 或 base_appliance_need_top 的 filler，
 * 从 material list 累积器中移除其原始产品行。
 * 因为 OCR 可能会把 DWP/RRP 误标为 filler，实际这些是由辅料规则自动生成的。
 */
function removeAdjacentFillers(layout: LayoutDocument, acc: Accumulator): void {
  for (const wall of layout.walls) {
    const allBlocks = [...wall.airBlocks, ...wall.groundBlocks];
    const positioned = positionBlocks(allBlocks);

    for (const pos of positioned) {
      if (pos.cat !== 'filler') continue;
      const leftNeighbor = getNeighbor(pos, positioned, 'left');
      const rightNeighbor = getNeighbor(pos, positioned, 'right');

      const adjacentToHighAppliance =
        (leftNeighbor && isFramedAppliance(leftNeighbor.cat)) ||
        (rightNeighbor && isFramedAppliance(rightNeighbor.cat));

      if (adjacentToHighAppliance) {
        for (const item of pos.block.items) {
          const currentQty = acc.itemQuantityBySku.get(item.sku);
          if (currentQty != null && currentQty > 0) {
            if (currentQty <= 1) {
              acc.itemQuantityBySku.delete(item.sku);
            } else {
              acc.itemQuantityBySku.set(item.sku, currentQty - 1);
            }
          }
        }
      }
    }
  }
}

// ==================================================================
//  主入口
// ==================================================================

/**
 * 根据 LayoutDocument 生成完整物料清单。
 * 不修改输入 layout。
 */
export function generateMaterialList(layout: LayoutDocument): MaterialListResult {
  const acc: Accumulator = {
    itemQuantityBySku: new Map(),
    lengthBySku: new Map(),
    warnings: [],
    seenItemIds: new Set(),
  };

  // 1. 原始柜/电器行（全局去重）
  collectOriginalItems(layout, acc);

  // 2. 逐墙处理辅料
  for (const wall of layout.walls) {
    const ground = positionBlocks(wall.groundBlocks);
    const air = positionBlocks(wall.airBlocks);

    // DWP（地轨 base_appliance_need_top）
    processDwp(wall, ground, acc);

    // 高电器信息（供 RRP / 侧板 / SM / CM 共用）
    const tallApps = collectTallAppliances(wall, air, ground, acc);

    // RRP（air 轨 tall_appliance + 叠放）
    processRrp(wall, air, ground, tallApps, acc);

    // 侧板
    processSidePanels(wall, air, ground, tallApps, acc);

    // TK
    processTk(wall, ground, acc);

    // QR
    processQr(wall, ground, acc);

    // SM（仅背墙不外露时）
    if (!wall.exposedBack) {
      processSm(wall, air, ground, tallApps, acc);
    }

    // CM
    processCm(wall, air, tallApps, acc);

    // 添加缺颜色信息警告
    for (const pos of [...ground, ...air]) {
      const color = blockColor(pos.block);
      const index = ground.includes(pos) ? ground.indexOf(pos) : air.includes(pos) ? air.indexOf(pos) : -1
      if (!color) warnMissingColor(acc, wall.name, index, pos.block);
    }
  }

  // 2.5. 清除紧邻高电器/需台面电器的 filler（OCR 误识别的 DWP/RRP）
  removeAdjacentFillers(layout, acc);

  // 3. 距料长度转数量（每色各自 ceil）
  for (const [sku, len] of acc.lengthBySku) {
    if (len > 0) {
      const qty = Math.ceil(len / MATERIAL_STICK_LENGTH);
      addDiscrete(acc, sku, qty);
    }
  }

  // 4. 排序输出：组内字母序
  const items: MaterialListItem[] = [...acc.itemQuantityBySku.entries()]
    .filter(([, q]) => q > 0)
    .map(([sku, quantity]) => ({ sku, quantity }))
    .sort((a, b) => {
      const ga = groupOf(a.sku);
      const gb = groupOf(b.sku);
      if (ga !== gb) return ga - gb;
      return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
    });

  const text = items.map((i) => `${i.sku} x ${i.quantity}`).join('\n');

  // 5. 距料原始长度明细（直接来自 lengthBySku，按 SKU 字母序）
  const lengthDetails: MaterialListLengthDetail[] = [...acc.lengthBySku.entries()]
    .filter(([, len]) => len > 0)
    .map(([sku, length]) => ({ sku, length }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

  return {
    text,
    items,
    lengthDetails,
    warnings: acc.warnings,
  };
}

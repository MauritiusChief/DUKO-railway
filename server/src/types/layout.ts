/**
 * 布局相关类型 —— 与 client/src/types.ts 保持一致
 *
 * 从 services/layoutTools.ts 中提取，供布局 Agent 和前端共享引用。
 */

// ==================================================================
//  轨道与分类
// ==================================================================

export type TrackSpan = 'air' | 'ground';

export type BlockItemCategory =
  | 'wall_cabinet'
  | 'base_cabinet'
  | 'tall_cabinet'
  | 'gap'
  | 'range_hood'
  | 'window'
  | 'tall_appliance'
  | 'base_appliance_need_top'
  | 'base_appliance_without_top';

// ==================================================================
//  数据模型
// ==================================================================

/** 一个布局块上的单个物品 */
export interface BlockItem {
  id: string;
  category: BlockItemCategory;
  sku: string;
}

/** 一个布局块（若干物品堆叠在一起的轨道片段） */
export interface SectionBlock {
  id: string;
  width: number;
  items: BlockItem[];
}

/** 一面墙（统一定义，岛台视为特殊墙面） */
export interface LayoutWall {
  id: string;
  name: string;
  width: number;
  exposedLeft: boolean;
  exposedRight: boolean;
  exposedBack: boolean;
  airBlocks: SectionBlock[];
  groundBlocks: SectionBlock[];
  connectedWallIds: string[];
  /** 背靠背岛台关系（仅 Agent 可编辑） */
  backToBackIslandIds: string[];
}

/** 布局文档顶层结构 */
export interface LayoutDocument {
  id: string;
  walls: LayoutWall[];
  createdAt: string;
  updatedAt: string;
}

/** 带距左距离的定位块 */
export interface PositionedBlock {
  block: SectionBlock;
  distanceFromLeft: number;
}

/** 布局指令（前端传给后端） */
export interface LayoutInstruction {
  dataUrl: string;
  viewType: 'top' | 'elevation' | '3d';
  associatedWallIds: string[];
}

// ==================================================================
//  MutableLayout —— 工具执行器通过此对象读写布局
// ==================================================================

export interface MutableLayout {
  layout: LayoutDocument;
}

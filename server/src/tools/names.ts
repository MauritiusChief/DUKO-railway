/**
 * 工具名注册中心 —— 所有 ToolName 字面量类型的单一真相源
 *
 * 将所有 ToolDefinition 常量汇入一个 as const 数组，
 * 从中自动推导 ToolName 联合类型。
 *
 * 用途：
 *  - types/tool.ts 中 ToolDefinition.function.name 收窄为 ToolName
 *  - 各处 agent 的 ownedToolNames / getBudgetedToolNames / switch case 均可使用此类型
 */
import { SEARCH_SKU_SHAPE_TOOL } from './search-shape.js';
import { SEARCH_SKU_DESCRIPTION_TOOL } from './search-description.js';
import { SEARCH_SKU_OVERLAP_TOOL } from './search-overlap.js';
import { SEARCH_SKU_STRUCTURED_TOOL } from './search-structured.js';
import {
  DISPATCH_BATCH_SEARCH_TOOL,
  DISPATCH_PRECISE_SEARCH_TOOL,
  DISPATCH_GLASS_DOOR_CALC_TOOL,
} from './dispatch.js';
import {
  READ_PARSED_ITEMS_TOOL,
  ADD_ITEM_TOOL,
  DELETE_ITEM_TOOL as DELETE_MANIFEST_ITEM_TOOL,
  EDIT_ITEM_CELL_TOOL,
} from './manifest.js';
import {
  LOOKUP_PRODUCT_INVENTORY_TOOL,
  LOOKUP_ITEM_COMPONENTS_TOOL,
  READ_GENERATED_PRODUCTS_TOOL,
} from './product.js';
import { RECORD_NOTE_TOOL } from './note.js';
import {
  READ_LAYOUT_TOOL,
  CREATE_WALL_TOOL,
  DELETE_WALL_TOOL,
  INSERT_ITEM_TOOL,
  DELETE_ITEM_TOOL as DELETE_LAYOUT_ITEM_TOOL,
  INSERT_ITEM_AT_POSITION_TOOL,
  UPDATE_WALL_PROPERTIES_TOOL,
  CONNECT_WALLS_TOOL,
  DISCONNECT_WALLS_TOOL,
  CONNECT_ISLANDS_TOOL,
  DISCONNECT_ISLANDS_TOOL,
} from './layout.js';

// ==================================================================
//  汇总数组 —— 所有 ToolDefinition 常量的 as const 元组
//  从这里自动推导 ToolName 联合类型
// ==================================================================

const ALL_TOOL_DEFS = [
  SEARCH_SKU_SHAPE_TOOL,
  SEARCH_SKU_DESCRIPTION_TOOL,
  SEARCH_SKU_OVERLAP_TOOL,
  SEARCH_SKU_STRUCTURED_TOOL,
  DISPATCH_BATCH_SEARCH_TOOL,
  DISPATCH_PRECISE_SEARCH_TOOL,
  DISPATCH_GLASS_DOOR_CALC_TOOL,
  READ_PARSED_ITEMS_TOOL,
  ADD_ITEM_TOOL,
  DELETE_MANIFEST_ITEM_TOOL,
  EDIT_ITEM_CELL_TOOL,
  LOOKUP_PRODUCT_INVENTORY_TOOL,
  LOOKUP_ITEM_COMPONENTS_TOOL,
  READ_GENERATED_PRODUCTS_TOOL,
  RECORD_NOTE_TOOL,
  READ_LAYOUT_TOOL,
  CREATE_WALL_TOOL,
  DELETE_WALL_TOOL,
  INSERT_ITEM_TOOL,
  DELETE_LAYOUT_ITEM_TOOL,
  INSERT_ITEM_AT_POSITION_TOOL,
  UPDATE_WALL_PROPERTIES_TOOL,
  CONNECT_WALLS_TOOL,
  DISCONNECT_WALLS_TOOL,
  CONNECT_ISLANDS_TOOL,
  DISCONNECT_ISLANDS_TOOL,
] as const;

/**
 * 所有工具名的字面量联合类型。
 * 从 ALL_TOOL_DEFS 中各常量的 function.name 字面量自动推导。
 *
 * 例如: 'searchSkuShape' | 'searchSkuDescription' | 'searchSkuStructured' | ... | 'disconnectIslands'
 * 以及虚构来用于提示预选信息的 '_budget_info'
 */
export type ToolName = (typeof ALL_TOOL_DEFS)[number]['function']['name'] | '_budget_info';

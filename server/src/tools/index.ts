/**
 * 工具模块统一导出
 *
 * 按领域分类，供 Agent 按需组装工具集。
 */

// 序列化工具（内部使用）
export {
  serializeRecord,
  serializeResult,
} from './serializers.js';

// 形状编辑距离搜索
export {
  SEARCH_SKU_SHAPE_TOOL,
  executeSearchSkuShape,
  searchSkuShapeInternal,
  shapeTypeEditDistance,
  shapeSizeEditDistance,
  colorMatches,
} from './search-shape.js';

// 描述 BM25 搜索
export {
  SEARCH_SKU_DESCRIPTION_TOOL,
  executeSearchSkuDescription,
} from './search-description.js';

// 形状 × 描述交集搜索
export {
  SEARCH_SKU_OVERLAP_TOOL,
  executeSearchSkuOverlap,
} from './search-overlap.js';

// 结构化多维度精确搜索
export {
  SEARCH_SKU_STRUCTURED_TOOL,
  executeSearchSkuStructured,
} from './search-structured.js';

// Dispatch 委派工具
export {
  DISPATCH_BATCH_SEARCH_TOOL,
  DISPATCH_PRECISE_SEARCH_TOOL,
  DISPATCH_GLASS_DOOR_CALC_TOOL,
} from './dispatch.js';

// 清单编辑
export {
  READ_PARSED_ITEMS_TOOL,
  ADD_ITEM_TOOL,
  DELETE_ITEM_TOOL,
  EDIT_ITEM_CELL_TOOL,
  executeReadParsedItems,
  executeAddItem,
  executeDeleteItem,
  executeEditItemCell,
  resolveIndexFromSnapshot,
} from './manifest.js';

// 产品查询与编辑
export {
  LOOKUP_PRODUCT_INVENTORY_TOOL,
  LOOKUP_ITEM_COMPONENTS_TOOL,
  READ_GENERATED_PRODUCTS_TOOL,
  executeLookupProductInventory,
  executeLookupItemComponents,
  executeReadGeneratedProducts,
} from './product.js';

// 笔记
export {
  RECORD_NOTE_TOOL,
  executeRecordNote,
} from './note.js';

// 预算
export {
  injectBudgetInfo,
} from './budget.js';

// 工具名类型（从所有 ToolDef 常量推导的联合类型）
export type { ToolName } from './names.js';

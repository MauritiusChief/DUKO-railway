/**
 * 清单相关类型 —— 解析后的客户清单与产品清单
 *
 * 从 routes/tableParse.ts 与 services/tools.ts 中提取，
 * 供多个 Agent 和工具模块共享引用。
 */

// ==================================================================
//  ParsedItem —— 清单中的一行（与 tableParse.ts 一致）
// ==================================================================

export interface ParsedField {
  values: string[];
}

export interface ParsedItem {
  originalName: string;
  color: ParsedField;
  shapeType: ParsedField;
  shapeSize: ParsedField;
  /** 数量 */
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

// ==================================================================
//  ProductEntry —— 产品清单中的单个条目
// ==================================================================

export interface ProductEntry {
  productName: string;
  description: string;
  quantity: number;
}

// ==================================================================
//  MutableManifest —— 工具执行器通过此对象读写当前清单
// ==================================================================

export interface MutableManifest {
  items: ParsedItem[];
  products: ProductEntry[];
  /** 每轮对话开始时的 items 快照（浅拷贝引用），用于跨工具调用索引解析 */
  itemSnapshot?: ParsedItem[];
  /** 每轮对话开始时的 products 快照（浅拷贝引用），用于跨工具调用索引解析 */
  productSnapshot?: ProductEntry[];
}

// ==================================================================
//  NoteAccumulator —— recordNote 工具累加器
// ==================================================================

export interface NoteAccumulator {
  notes: Array<{ originalName: string; content: string }>;
}

// ==================================================================
//  ChatNote —— 前端传递的笔记
// ==================================================================

export interface ChatNote {
  originalName: string;
  content: string;
}

// ==================================================================
//  ChatHistory —— 清理后的对话历史条目
// ==================================================================

export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

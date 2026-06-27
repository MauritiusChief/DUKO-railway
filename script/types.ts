// 类型定义 —— ScriptCat 脚本与面板共享
// 从 MIGRATION_PLAN §3.2 提取并适配

/** rspack DefinePlugin 构建时注入的时间戳 */
declare const __BUILD_TS__: string;

/** Odoo quotation 表中一行待写入的零件 */
export interface WrittenPart {
  /** 零件型号（如 02B15-D） */
  partModel: string;
  /** 数量 */
  quantity: number;
}

/** CSV 解析后的一行预览数据 */
export interface CsvRow {
  productName: string;
  quantity: number;
}

/** 写入结果 */
export interface WriteResult {
  /** 成功写入的行数 */
  successCount: number;
  /** 未能写入的零件列表 */
  unfilledParts: WrittenPart[];
}

/** 面板状态：就绪 → 执行中 → 完成/出错 */
export type PanelStatus = 'idle' | 'writing' | 'done' | 'error';

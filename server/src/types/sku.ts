/**
 * SKU 记录类型定义
 *
 * 与 Exposed-Items.csv 列一一对应，共 14 个字段 + 嵌入向量。
 * 供 LanceDB、SQLite 及各消费者模块（retriever、bm25、exposed-check 等）共用。
 *
 * itemName = colorCode + shapeTypeCode + shapeSizeCode（对普通物品而言）；
 * shapeTypeAlias / shapeSizeAlias / mainAlias 为逗号分隔的别名列表。
 */

/** 存入 LanceDB / SQLite 的 SKU 记录结构 */
export interface SkuRecord {
  id: string;
  itemName: string;
  colorCode: string;
  shapeTypeCode: string;
  shapeTypeAlias: string;
  shapeSizeCode: string;
  shapeSizeAlias: string;
  subItemsName: string;
  mainDescription: string;
  mainAlias: string;
  sizeDescription: string;
  otherDescription: string;
  /** 拼接后的全文（用于生成 embedding） */
  text: string;
  /** embedding 向量（384 维），仅供 LanceDB 使用 */
  vector: number[];
}

/** 向量检索返回结果 —— 在 SkuRecord 基础上附加余弦距离 */
export interface SkuSearchResult extends SkuRecord {
  /** 余弦距离（越小越相似） */
  _distance: number;
}

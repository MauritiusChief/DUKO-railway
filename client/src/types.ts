/**
 * 前后端共享类型定义
 *
 * 表格解析 agent 的数据结构
 */

/** 表格中单个字段的解析结果。
 *  values 数组长度表示信心程度：
 *    length === 1 → 确认（白色背景）
 *    length  >  1 → 候选（橙色背景）
 *    length === 0 → 未知（红色背景） */
export interface ParsedField {
  values: string[];
}

/** 表格中的一行 —— 对应输入中的一项物品 */
export interface ParsedItem {
  /** 输入中的原始名称/型号（只读） */
  originalName: string;
  /** 颜色解析结果 */
  color: ParsedField;
  /** 形状型号解析结果 */
  shapeType: ParsedField;
  /** 形状尺寸解析结果 */
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

/** POST /api/table-parse 的完整响应 */
export interface TableParseResponse {
  items: ParsedItem[];
}

/** GET /api/colors 的响应 —— 单个颜色条目 */
export interface ColorEntry {
  code: string;
  name: string;
}

/** POST /api/check-exposed 的请求体。
 *  colorCode 或 shapeSizeCode 为空字符串表示该字段被忽略，比对时跳过。 */
export interface CheckExposedRequest {
  combos: ({ colorCode: string; shapeTypeCode: string; shapeSizeCode: string } | null)[];
}

/** POST /api/check-exposed 的响应体 */
export interface CheckExposedResponse {
  /** true=组合存在, false=组合不存在, null=该行字段不完整 */
  results: (boolean | null)[];
}

/** POST /api/generate-products 产品列表中单个条目 */
export interface ProductEntry {
  /** Product.csv 中的 NAME（sharedPartName） */
  productName: string;
  /** Parts.csv 中的 description（产品描述） */
  description: string;
  /** 合并后的数量 */
  quantity: number;
  /** 折扣百分比（%）—— 按最终产品型号颜色前缀推导；不打折时省略 */
  discount?: number;
}

/** POST /api/generate-products 的完整响应 */
export interface GenerateProductsResponse {
  products: ProductEntry[];
  /** 未能解析的行数 */
  unresolvedCount: number;
  /** 未能解析的行索引列表 */
  unresolvedIndices: number[];
}

/** AI 笔记条目 */
export interface Note {
  id: number;
  originalName: string;
  content: string;
}

/** 对话历史中的一条消息 */
export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

/** 存储用的对话条目 —— 兼顾历史渲染和衍生 LLM 对话上下文。
 *  parse_start 提供解析摘要展示，user / assistant 提供对话详情。 */
export interface ConversationEntry {
  role: 'user' | 'assistant' | 'parse_start';
  content: string;
  meta?: { lineCount?: number; colorCodes?: string[] };
}

/** 历史记录摘要（列表用） */
export interface HistoryRecordSummary {
  id: number;
  itemCount: number;
  created_at: string;
}

/** 管理员全量历史记录摘要（含归属用户信息） */
export interface AllHistoryRecordSummary {
  id: number;
  itemCount: number;
  created_at: string;
  user_id: number;
  username: string;
}

/** 历史记录完整详情 */
export interface HistoryRecordFull {
  id: number;
  input: string;
  colorHints: string[];
  items: ParsedItem[];
  conversation: ConversationEntry[];
  lang: string;
  created_at: string;
}

/** POST /api/chat 的请求体 */
export interface ChatRequest {
  message: string;
  items?: ParsedItem[];
  products?: ProductEntry[];
  history?: ChatHistoryEntry[];
  notes?: Note[];
}

/** POST /api/chat 的响应体 */
export interface ChatResponse {
  reply: string;
  items?: ParsedItem[];
  products?: ProductEntry[];
  history: ChatHistoryEntry[];
  notes?: Note[];
}

/** POST /api/image-parse 的响应体 —— 图片解析后返回的文本 */
export interface ImageParseResponse {
  /** 视觉模型解析后输出的结构化文本，可预填入文本输入框供后续 text agent 解析 */
  text: string;
}

// ==================================================================
//  Layout Recognize —— 布局识别模块类型
// ==================================================================

/** 轨道类型：空中或地面 */
export type TrackSpan = 'air' | 'ground';

/** 物品分类（抽象名，不含具体品牌） */
export type BlockItemCategory =
  | 'wall_cabinet'            // 吊柜
  | 'base_cabinet'            // 地柜
  | 'tall_cabinet'            // 高柜（通天，占双轨）
  | 'gap'                      // 空挡
  | 'stuffed_gap'              // 塞了东西的空挡（hood/window 等），本质同 gap
  | 'gaplike_item'             // 类似 gap 的商品（VAL/GH/WES），进清单但两侧遮挡不住
  | 'filler'                   // 填充条（BF/WF/TF），进清单但紧邻高电器时自动清除
  | 'tall_appliance'          // 高电器（冰箱等，占双轨）
  | 'base_appliance_need_top'  // 需台面电器（洗碗机等）
  | 'base_appliance_without_top'; // 免台面电器（灶台等）

/** block 中的一个物品 */
export interface BlockItem {
  id: string;
  /** 抽象分类 */
  category: BlockItemCategory;
  /** 必填。柜体填 DUKO SKU（如 "02B15"），非柜体填具体名称（如 "refrigerator"） */
  sku: string;
  /** 是否为 vanity cabinet（仅 base_cabinet 有效） */
  isVanity?: boolean;
  /** 物品高度（英寸），地面柜无需记录。air 轨 wall_cabinet / tall_cabinet / tall_appliance 及叠放吊柜均需填写 */
  height?: number;
}

/** 轨道中的一个排列单元 */
export interface SectionBlock {
  id: string;
  /** 宽度（英寸），不存位置，位置靠左侧块累积宽度实时计算 */
  width: number;
  /** items 中多 item = 吊柜垂直叠放 */
  items: BlockItem[];
  /** 该块的颜色代码（如 "02"），空字符串表示未选 */
  colorCode?: string;
}

/** 墙（统一定义，岛台视为特殊墙面） */
export interface LayoutWall {
  id: string;
  name: string;
  /** 墙总宽度（英寸） */
  width: number;
  exposedLeft: boolean;
  exposedRight: boolean;
  exposedBack: boolean;
  airBlocks: SectionBlock[];
  groundBlocks: SectionBlock[];
  /** L 形连接的其他墙 id（仅 Agent 可编辑） */
  connectedWallIds: string[];
  /** 背靠背岛台关系（仅 Agent 可编辑） */
  backToBackIslandIds: string[];
}

/** 布局文档 */
export interface LayoutDocument {
  id: string;
  walls: LayoutWall[];
  createdAt: string;
  updatedAt: string;
}

/** 传给 Agent 的图片指导线索（不持久化） */
export interface LayoutInstruction {
  /** base64 data URL */
  dataUrl: string;
  viewType: 'top' | 'elevation' | '3d';
  /** 此图描述哪些墙/岛台 id */
  associatedWallIds: string[];
}

/** 轨道中 block 的计算位置 */
export interface PositionedBlock {
  block: SectionBlock;
  /** 距轨道最左侧距离（英寸），实时计算，不存储 */
  distanceFromLeft: number;
}

// ==================================================================
//  Trace —— LLM 对话追踪（仅管理员可见）
// ==================================================================

/** GET /api/trace 列表项 */
export interface TraceSessionSummary {
  conversation_id: string;
  username: string;
  user_id: number;
  main_agent: string;
  agent_name: string;
  parent_tool_call_id: string | null;
  route: string;
  provider: string;
  model: string;
  status: 'running' | 'completed' | 'error';
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ClientSentMessage {
  id: number;
  conversation_id: string;
  message_index: number;
  role: 'system' | 'user' | 'tool' | 'tool_schema';
  name: string | null;
  tool_call_id: string | null;
  parent_tool_call_id: string | null;
  content_text: string | null;
  content_json: string | null;
  content_format: 'text' | 'markdown' | 'json' | 'multimodal_placeholder';
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface ClientReceivedMessage {
  id: number;
  conversation_id: string;
  message_index: number;
  finish_reason: string | null;
  reply: string | null;
  reasoning: string | null;
  tool_calls_json: string | null;
  tool_call_ids_json: string | null;
  source: 'llm' | 'injected';
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

export type TraceMessage = ClientSentMessage | ClientReceivedMessage;

export interface TraceSessionDetail {
  session: TraceSessionSummary;
  messages: TraceMessage[];
}

/** 分组后的消息块（前端渲染用） */
export interface TraceGroup {
  kind: 'sent' | 'assistant';
  sent?: ClientSentMessage;
  assistant?: ClientReceivedMessage;
  /** 归属于此 assistant 的 tool 结果 */
  tools: ClientSentMessage[];
  /** 归属于此 assistant 的 _budget_info（source=injected） */
  budget?: { received: ClientReceivedMessage; sent: ClientSentMessage };
}

// ==================================================================
//  报价任务 (Quotation Tasks)
// ==================================================================

export type QuotationTaskStatus =
  | 'queued' | 'running' | 'completed' | 'partial_failed' | 'failed' | 'cancelled'

export interface QuotationTaskLine {
  lineNo: number
  partModel: string
  quantity: number
  /** 折扣百分比（%）—— 空值表示不指定，不触碰 Odoo 折扣 */
  discount?: number
  status: 'pending' | 'success' | 'failed'
  error: string | null
}

export interface QuotationTaskSummary {
  id: number
  userId: number
  username: string
  quotationNumber: string
  odooUrl: string
  writeMode: 'overwrite' | 'append'
  status: QuotationTaskStatus
  taskError: string | null
  retryCount: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  lineCount: number
  successCount: number
  failedCount: number
}

export interface QuotationTaskDetail extends QuotationTaskSummary {
  lines: QuotationTaskLine[]
  pendingConfirmation: string | null
  finalLinesSnapshot: string | null
}

export interface QuotationSnapshotLine {
  productModel: string
  quantity: string
  /** 折扣百分比（%）—— 空值表示 Odoo 中无折扣或未指定 */
  discount?: number
}

export interface ActiveTaskSummaryResponse {
  activeTask?: {
    taskId: number
    quotationNumber: string
    username: string
    startedAt: string
    status: QuotationTaskStatus
  }
}

export interface WorkerStatusResponse {
  autoOnline: boolean
}

/** 全局排队队列摘要（跨用户，公开） */
export interface QueueSummary {
  queuedCount: number
  tasks: {
    taskId: number
    quotationNumber: string
    username: string
    createdAt: string
  }[]
}

/** 草稿（localStorage 持久化） */
export interface QuotationDraft {
  quotationNumber: string
  odooUrl: string
  writeMode: 'overwrite' | 'append'
  csvText: string
  savedAt: number
}

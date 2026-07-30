/**
 * ChatAgent —— 聊天对话 Agent
 *
 * 继承 BaseAgent，提供 DUKO 橱柜产品查询与清单编辑能力。
 * 可用工具：
 *   搜索（受预算限制）：searchSkuShape, searchSkuDescription, searchSkuStructured
 *   清单编辑（不受预算限制）：readParsedItems, addItem, deleteItem, editItemCell
 *   产品查询（不受预算限制）：lookupProductInventory, lookupItemComponents
 *   产品清单读取（不受预算限制）：readGeneratedProducts
 *   笔记（不受预算限制）：recordNote
 *
 * 对话循环内通过 MutableManifest 共享可变清单状态。
 */

import { BaseAgent, type AgentContext, type BaseAgentConfig } from './base.js';
import type { ToolDefinition, ToolCall } from '../types/tool.js';
import type { ChatMessage } from '../types/message.js';
import type { ChatHistoryEntry } from '../types/manifest.js';
import type { LlmProvider } from '../llm/provider.js';
import type {
  MutableManifest,
  ParsedItem,
  ProductEntry,
  NoteAccumulator,
  ChatNote,
} from '../types/manifest.js';

import {
  SEARCH_SKU_SHAPE_TOOL,
  executeSearchSkuShape,
} from '../tools/search-shape.js';

import {
  SEARCH_SKU_DESCRIPTION_TOOL,
  executeSearchSkuDescription,
} from '../tools/search-description.js';

import {
  SEARCH_SKU_STRUCTURED_TOOL,
  executeSearchSkuStructured,
} from '../tools/search-structured.js';

import {
  READ_PARSED_ITEMS_TOOL,
  ADD_ITEM_TOOL,
  DELETE_ITEM_TOOL,
  EDIT_ITEM_CELL_TOOL,
  executeReadParsedItems,
  executeAddItem,
  executeDeleteItem,
  executeEditItemCell,
} from '../tools/manifest.js';

import {
  LOOKUP_PRODUCT_INVENTORY_TOOL,
  LOOKUP_ITEM_COMPONENTS_TOOL,
  READ_GENERATED_PRODUCTS_TOOL,
  executeLookupProductInventory,
  executeLookupItemComponents,
  executeReadGeneratedProducts,
} from '../tools/product.js';
import { getSkuRefreshMetadata } from '../db/sku.js';

import {
  RECORD_NOTE_TOOL,
  executeRecordNote,
} from '../tools/note.js';

import { getColorTable } from '../services/utils.js';
import { config } from '../config/env.js';
import { writeChatLog } from '../services/logger.js';
import { ToolName } from '../tools/index.js';
import { computeExposedStatus } from '../services/exposed-check.js';

// ==================================================================
//  ChatAgent 专用上下文
// ==================================================================

export interface ChatAgentContext extends AgentContext {
  manifest: MutableManifest;
  noteAccumulator: NoteAccumulator;
  requestHistory?: ChatHistoryEntry[];
  requestNotes?: ChatNote[];
  tableParseAgentReply?: string;
  initialInput?: string;
  colorHints?: string[];
}

// ==================================================================
//  ChatAgent 专用配置
// ==================================================================

export interface ChatAgentConfig extends BaseAgentConfig {
  /** 多轮对话历史最大用户-助手对数 */
  maxHistoryPairs: number;
}

// ==================================================================
//  ChatAgent
// ==================================================================

export class ChatAgent extends BaseAgent<ChatMessage> {
  /** 本 Agent 拥有的全部工具名 */
  static override ownedToolNames = [
    'searchSkuShape',
    'searchSkuDescription',
    'searchSkuStructured',
    'readParsedItems',
    'addItem',
    'deleteItem',
    'editItemCell',
    'lookupProductInventory',
    'lookupItemComponents',
    'readGeneratedProducts',
    'recordNote',
  ];

  private colorTable: string;
  private maxHistoryPairs: number;

  constructor(
    llm: LlmProvider<ChatMessage>,
    config: ChatAgentConfig,
  ) {
    super(llm, config);
    this.maxHistoryPairs = config.maxHistoryPairs;
    this.colorTable = getColorTable();
  }

  getSystemPrompt(): string {
    return this.buildSystemPrompt();
  }

  // ---- 所有工具定义 ----

  getTools(): ToolDefinition[] {
    return [
      // 搜索工具（受预算限制）
      SEARCH_SKU_SHAPE_TOOL,
      SEARCH_SKU_DESCRIPTION_TOOL,
      SEARCH_SKU_STRUCTURED_TOOL,
      // 清单编辑工具
      READ_PARSED_ITEMS_TOOL,
      ADD_ITEM_TOOL,
      DELETE_ITEM_TOOL,
      EDIT_ITEM_CELL_TOOL,
      // 产品查询工具
      LOOKUP_PRODUCT_INVENTORY_TOOL,
      LOOKUP_ITEM_COMPONENTS_TOOL,
      // 产品清单读取工具
      READ_GENERATED_PRODUCTS_TOOL,
      // 笔记工具
      RECORD_NOTE_TOOL,
    ];
  }

  getBudgetedToolNames(): Set<ToolName> {
    return new Set(['searchSkuShape', 'searchSkuDescription', 'searchSkuStructured']);
  }

  // ---- 快照管理 ----
  //
  // 同一轮对话中 LLM 可能发出多个工具调用（如先删除再编辑），
  // 但所有调用基于同一份 readParsedItems 快照中的行序号。
  // 前置的增/删操作会改变数组长度与元素位置，导致后续工具的 rowIndex 失效。
  // 此方法在本轮工具执行前保存 items / products 的快照（浅拷贝保留对象引用），
  // resolveIndexFromSnapshot 通过对象引用（===）将旧序号映射到当前数组位置。
  protected onBeforeToolRound(_messages: ChatMessage[], context: AgentContext): void {
    const ctx = context as ChatAgentContext;
    ctx.manifest.itemSnapshot = [...ctx.manifest.items];
    ctx.manifest.productSnapshot = [...ctx.manifest.products];
  }

  // ---- 工具执行分发 ----

  protected async executeTool(
    tc: ToolCall,
    context: AgentContext,
  ): Promise<string> {
    const ctx = context as ChatAgentContext;
    let args: Record<string, unknown> = {};

    try {
      if (tc.function.arguments) {
        args = JSON.parse(tc.function.arguments);
      }
    } catch {
      console.warn(`[ChatAgent] ${tc.function.name} 参数解析出错`);
    }

    switch (tc.function.name) {
      case 'searchSkuShape':
        return executeSearchSkuShape(args);

      case 'searchSkuDescription':
        return executeSearchSkuDescription(args);

      case 'searchSkuStructured':
        return executeSearchSkuStructured(args);

      case 'readParsedItems':
        return executeReadParsedItems(ctx.manifest);

      case 'addItem':
        return executeAddItem(ctx.manifest, args);

      case 'deleteItem':
        return executeDeleteItem(ctx.manifest, args);

      case 'editItemCell':
        return executeEditItemCell(ctx.manifest, args);

      case 'lookupProductInventory':
        return executeLookupProductInventory(args);

      case 'lookupItemComponents':
        return executeLookupItemComponents(args);

      case 'readGeneratedProducts':
        return executeReadGeneratedProducts(ctx.manifest);

      case 'recordNote':
        return executeRecordNote(ctx.noteAccumulator, args);

      default:
        return `未知工具: ${tc.function.name}`;
    }
  }

  // ================================================================
  //  Public API —— 对接路由层的便捷方法
  // ================================================================

  /**
   * 组装初始消息（system + history + user）并执行对话循环。
   */
  async chat(args: {
    message: string;
    lang?: string;
    items?: ParsedItem[];
    products?: ProductEntry[];
    history?: ChatHistoryEntry[];
    notes?: ChatNote[];
    tableParseAgentReply?: string;
    initialInput?: string;
    colorHints?: string[];
  }): Promise<{
    reply: string;
    items?: ParsedItem[];
    products?: ProductEntry[];
    history: ChatHistoryEntry[];
    notes?: ChatNote[];
  }> {
    const langHint = args.lang === 'en' ? '英文' : '中文';
    (this.config as { langHint: string }).langHint = langHint;

    const manifest: MutableManifest = {
      items: args.items ? args.items.map((it) => ({ ...it })) : [],
      products: args.products ? args.products.map((p) => ({ ...p })) : [],
    };

    const noteAccumulator: NoteAccumulator = { notes: [] };
    const itemsWereProvided = args.items && args.items.length > 0;

    const context: ChatAgentContext = {
      manifest,
      noteAccumulator,
      requestHistory: args.history,
      requestNotes: args.notes,
      tableParseAgentReply: args.tableParseAgentReply,
      initialInput: args.initialInput,
      colorHints: args.colorHints,
    };

    // 组装消息
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: this.buildSystemPrompt(
          langHint,
          args.notes || [],
          args.tableParseAgentReply,
          args.initialInput,
          args.colorHints,
        ),
      },
    ];

    // 注入历史对话
    if (args.history && args.history.length > 0) {
      for (const entry of args.history) {
        if (
          (entry.role === 'user' || entry.role === 'assistant') &&
          entry.content?.trim()
        ) {
          messages.push({ role: entry.role, content: entry.content.trim() });
        }
      }
    }

    // 追加用户消息
    messages.push({ role: 'user', content: args.message });

    const result = await this.run(messages, context);

    if (config.chatLog) {
      writeChatLog(result.messages);
    }

    // 清理对话历史
    const history = this.cleanHistory(result.messages);

    // 计算 Exposed-Items 匹配状态（直接写入每个 item 的 status / colorIgnored / shapeSizeIgnored）
    let resultItems: ParsedItem[] | undefined;

    if (manifest.items.length > 0) {
      computeExposedStatus(manifest.items);
      resultItems = manifest.items as ParsedItem[];
    } else if (itemsWereProvided) {
      resultItems = [];
    }

    return {
      reply: result.reply,
      items: resultItems,
      products: manifest.products,
      history,
      notes: noteAccumulator.notes.length > 0 ? noteAccumulator.notes : undefined,
    };
  }

  // ================================================================
  //  Private helpers
  // ================================================================

  private buildSystemPrompt(
    langHint: string = '中文',
    notes: Array<{ originalName: string; content: string }> = [],
    tableParseAgentReply?: string,
    initialInput?: string,
    colorHints?: string[],
  ): string {
    let notesSection = '';
    if (notes.length > 0) {
      const notesList = notes
        .map((n) => `- ${n.originalName}：${n.content}`)
        .join('\n');
      notesSection = `
## 已有笔记（产品型号映射参考）

以下是从过往对话中记录的产品型号映射笔记，在回答用户问题和搜索产品时可作为参考：

${notesList}
`;
    }

    let tableParseAgentSection = '';
    if (tableParseAgentReply || initialInput || (colorHints && colorHints.length > 0)) {
      tableParseAgentSection = '\n## 上一轮解析上下文\n\n';
      if (tableParseAgentReply) {
        tableParseAgentSection += `解析 agent 的总结：${tableParseAgentReply}\n\n`;
      }
      if (initialInput) {
        tableParseAgentSection += `用户提交的原始清单文本：\n\`\`\`\n${initialInput}\n\`\`\`\n\n`;
      }
      if (colorHints && colorHints.length > 0) {
        tableParseAgentSection += `用户点击的颜色提示：${colorHints.join(', ')}\n\n`;
      }
    }

    // 库存数据新鲜度提示：依据 sku_refresh_metadata 动态生成，避免模型用过时表述误导用户
    const refreshMeta = getSkuRefreshMetadata();
    const inventoryFreshnessClause = refreshMeta?.lastSuccessfulRefreshAt
      ? `来自产品数据库的静态快照，上次成功刷新时间为 ${refreshMeta.lastSuccessfulRefreshAt}（UTC），可能与实时 ERP 存在差异。`
      : `来自产品数据库的静态快照，上次成功刷新时间未知，可能已过时。`;

    return `你是一个 DUKO 橱柜产品查询与清单编辑助手。你可以帮助用户查询产品信息、编辑已解析的客户清单、以及查询产品库存。${tableParseAgentSection}
## 产品代码规则

- itemName 格式为 {颜色代码}{形状代码}{尺寸代码}，如 "02B15" = 颜色02 + B型 + 15寸
- 颜色代码对照表：
${this.colorTable}
- 形状代码：B=Base(底柜), W=Wall(吊柜), T=Tall(高柜), ACM=Angled Crown Molding, UT=Utility, 等等
- 尺寸代码：数字表示宽度（英寸）

## 清单编辑工具（可随意使用，无次数限制）

你可以使用以下工具读取和编辑客户清单：
- **readParsedItems**：读取当前清单，返回带序号（# 列）的 Markdown 表格。每次编辑前应调用此工具确认当前状态。
- **addItem**：向清单中插入新行。rowIndex 可选，省略则添加至末尾。至少需提供 originalName，其他字段可选。**colorCode / shapeTypeCode / shapeSizeCode 可用逗号分隔传入多个候选值**（如 colorCode="02, 03, 14"），前端会自动显示为多选 radio
- **deleteItem**：删除指定行。rowIndex 来自 readParsedItems 返回的 # 列（1-based）。
- **editItemCell**：编辑指定单元格。column 可选 "color"、"shapeType"、"shapeSize"、"quantity"。**value 同样支持逗号分隔的多候选值**

编辑流程建议：先 readParsedItems → 确认行号 → 编辑 → 编辑完成后无需再次 readParsedItems 确认，直接告知用户结果即可。

## 搜索工具（有轮数限制）

你可以调用以下工具搜索 DUKO 产品数据库，但有轮数限制：
- **searchSkuShape**：按形状类型代码模糊搜索。使用编辑距离匹配 shapeTypeCode/shapeSizeCode 的近似值。shapeTypeCode 必填，shapeSizeCode 可选，colorCode 填颜色代码或 "*"。当用户查询的形状代码可能拼写有误、不完整时使用。
- **searchSkuDescription**：按自然语言描述 BM25 全文检索。在 mainDescription、mainAlias、sizeDescription、otherDescription 字段中搜索英文词语。query 用英文，colorCode 必填（"*" 匹配任意颜色）。适用只有描述没有代码的场景。
- **searchSkuStructured**：结构化多维度精确检索。支持三个过滤维度：shapeFilter（JSON 过滤树，编辑距离匹配形状）、descriptionFilter（JSON 过滤树，BM25 匹配描述）、vectorFilter（向量语义搜索），外加 color 限定。适合复杂多条件查询。

工具预算会在每轮工具调用后自动通知你。预算耗尽后受限工具不可用，但你仍可随意使用清单编辑工具和产品查询工具。

## 笔记工具（可随意使用，无次数限制）

- **recordNote**：当用户指出某个产品/型号的实际正确名称时，将此映射记录为笔记。笔记会在后续对话中自动注入供参考。

## 产品库存查询工具（可随意使用，无次数限制）

- **lookupProductInventory**：输入 Exposed-Items 中的 itemName，查询其对应的 DUKO 实际产品名称及库存数量。
  **⚠️ 重要提示**：当前该工具返回的 Forecasted Quantity（预测数量）、Free to use Quantity（可用数量）、Quantity On Hand（在手数量）${inventoryFreshnessClause}请如实告知用户此局限性，建议以实际 ERP 系统数据为准。

## 产品组件查询工具（可随意使用，无次数限制）

- **lookupItemComponents**：通过完整型号查询其在 DUKO 产品数据库中的最终组成 Product（柜门组件/主体组件/额外组件）。当用户需要了解某个完整型号实际包含哪些 Product 时调用此工具。
- **readGeneratedProducts**：读取当前已生成的产品清单。注意：产品清单由前端"生成产品清单"按钮生成，chat agent 仅可**读取**，不可编辑。

## 返回结果

- 使用${langHint}回复，简洁明了。
- 用户界面为${langHint}，因此用户大概率使用${langHint}沟通。
- 搜索到产品时列出产品代码、描述、尺寸和子产品信息。**如果搜索返回多个匹配结果，列出全部候选项（而非只选一个），让用户自行判断**
- 编辑清单后告知用户修改了什么。
- 当用户要求修改清单但某个字段不确定唯一值时，用逗号分隔传入多个候选值让用户在界面上选择
- 用户未提供清单时，仅做搜索应答，不主动建议编辑清单。${notesSection}`;
  }

  private cleanHistory(messages: ChatMessage[]): ChatHistoryEntry[] {
    const cleaned: ChatHistoryEntry[] = [];
    for (const m of messages) {
      if (
        (m.role === 'user' || m.role === 'assistant') &&
        m.content?.trim() &&
        !(m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0)
      ) {
        cleaned.push({ role: m.role, content: m.content.trim() });
      }
    }
    const maxLen = this.maxHistoryPairs * 2;
    if (cleaned.length > maxLen) {
      return cleaned.slice(cleaned.length - maxLen);
    }
    return cleaned;
  }
}

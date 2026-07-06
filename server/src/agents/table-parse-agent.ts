/**
 * TableParseAgent —— 解析清单编排 Agent
 *
 * 接收原始清单文本，拆分并委派给三个子 agent（BatchSearch / PreciseSearch / GlassDoor），
 * 自身可通过 searchSkuXxx 工具补漏，通过清单编辑工具（addItem / deleteItem / editItemCell）
 * 逐步构建 manifest。
 *
 * 单请求即完结。不做产品清单编辑，不写笔记。仅保留 lookupItemComponents 供 LLM 自主验证。
 *
 * 最终输出：
 *  - items：从 MutableManifest 提取，每项 status 由 computeExposedStatus() 自动写入
 *  - reply：呈现在 ChatPanel 中的简短文本总结
 */

import { BaseAgent, type AgentContext, type BaseAgentConfig } from './base.js';
import type { ToolDefinition, ToolCall } from '../types/tool.js';
import type { ChatMessage } from '../types/message.js';
import type { LlmProvider } from '../llm/provider.js';
import type {
  MutableManifest,
  ParsedItem,
  ChatNote,
} from '../types/manifest.js';

import {
  DISPATCH_BATCH_SEARCH_TOOL,
  DISPATCH_PRECISE_SEARCH_TOOL,
  DISPATCH_GLASS_DOOR_CALC_TOOL,
} from '../tools/dispatch.js';

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
  LOOKUP_ITEM_COMPONENTS_TOOL,
  executeLookupItemComponents,
} from '../tools/product.js';

import { getColorTable, getShapeTypeTable, getColorEntries } from '../services/utils.js';
import { config } from '../config/env.js';
import { writeChatLog } from '../services/logger.js';
import { BatchSearchAgent } from './batch-search-agent.js';
import { PreciseSearchAgent } from './precise-search-agent.js';
import { GlassDoorAgent } from './glass-door-agent.js';
import { ToolName } from '../tools/index.js';
import { computeExposedStatus } from '../services/exposed-check.js';

// ==================================================================
//  TableParseAgent 专用上下文
// ==================================================================

export interface TableParseAgentContext extends AgentContext {
  manifest: MutableManifest;
  inputLines: string[];
  notes?: ChatNote[];
  fromImage?: boolean;
}

// ==================================================================
//  TableParseAgent
// ==================================================================

export class TableParseAgent extends BaseAgent<ChatMessage> {
  static override ownedToolNames = [
    'dispatchBatchSearch',
    'dispatchPreciseSearch',
    'dispatchGlassDoorCalc',
    'searchSkuShape',
    'searchSkuDescription',
    'searchSkuStructured',
    'readParsedItems',
    'addItem',
    'deleteItem',
    'editItemCell',
    'lookupItemComponents',
  ];

  private colorTable: string;
  private shapeTypeTable: string;

  constructor(llm: LlmProvider<ChatMessage>, config: BaseAgentConfig) {
    super(llm, config);
    this.colorTable = getColorTable();
    this.shapeTypeTable = getShapeTypeTable();
  }

  getSystemPrompt(): string {
    return '';
  }

  getTools(): ToolDefinition[] {
    return [
      DISPATCH_BATCH_SEARCH_TOOL,
      DISPATCH_PRECISE_SEARCH_TOOL,
      DISPATCH_GLASS_DOOR_CALC_TOOL,
      SEARCH_SKU_SHAPE_TOOL,
      SEARCH_SKU_DESCRIPTION_TOOL,
      SEARCH_SKU_STRUCTURED_TOOL,
      READ_PARSED_ITEMS_TOOL,
      ADD_ITEM_TOOL,
      DELETE_ITEM_TOOL,
      EDIT_ITEM_CELL_TOOL,
      LOOKUP_ITEM_COMPONENTS_TOOL,
    ];
  }

  getBudgetedToolNames(): Set<ToolName> {
    // 搜索工具 + dispatch 工具均计入预算，与 isBudgetedTool 自动一致
    return new Set([
      'searchSkuShape',
      'searchSkuDescription',
      'searchSkuStructured',
      'dispatchBatchSearch',
      'dispatchPreciseSearch',
      'dispatchGlassDoorCalc',
    ]);
  }

  /**
   * 将委派子 agent 的 dispatch 工具标记为可并发执行。
   * 当 LLM 在同一轮中发起多个 dispatchBatchSearch / dispatchPreciseSearch /
   * dispatchGlassDoorCalc 调用时，它们会通过 Promise.all 并行执行，
   * 避免多个子 agent 串行等待。
   */
  protected override canExecuteInParallel(toolName: ToolName): boolean {
    return [
      'dispatchBatchSearch',
      'dispatchPreciseSearch',
      'dispatchGlassDoorCalc',
    ].includes(toolName);
  }

  // ---- 快照管理（同 ChatAgent，确保同轮多工具调用 rowIndex 一致） ----

  protected onBeforeToolRound(
    _messages: ChatMessage[],
    context: AgentContext,
  ): void {
    const ctx = context as TableParseAgentContext;
    ctx.manifest.itemSnapshot = [...ctx.manifest.items];
    ctx.manifest.productSnapshot = [...ctx.manifest.products];
  }

  // ================================================================
  //  工具执行分发
  // ================================================================

  protected async executeTool(
    tc: ToolCall,
    context: AgentContext,
  ): Promise<string> {
    const ctx = context as TableParseAgentContext;
    const args = this.parseArgs(tc.function.arguments);

    switch (tc.function.name) {
      // ---- dispatch 工具 ----

      case 'dispatchBatchSearch': {
        const batch = Array.isArray(args.batch) ? args.batch : [];
        if (batch.length === 0) return 'dispatchBatchSearch: batch 为空或格式错误';
        const sub = new BatchSearchAgent(this.llm, {
          searchBudgetLimit: 5,
          maxRounds: 8,
          langHint: this.config.langHint,
          onStep: (evt) => {
            if (evt.type === 'tool_call') {
              this.config.onStep?.({ type: 'tool_call', tool: `batch>${evt.tool}` });
            }
          },
        });
        if (this.trace) {
          sub.trace = this.initSubTrace(this.trace, 'BatchSearchAgent', tc.id);
        }
        return sub.runBatch(batch);
      }

      case 'dispatchPreciseSearch': {
        const item = (args.item as Record<string, unknown>) || {};
        const originalName = String(item.originalName ?? '');
        if (!originalName) return 'dispatchPreciseSearch: item.originalName 必填';
        const sub = new PreciseSearchAgent(this.llm, {
          searchBudgetLimit: 5,
          maxRounds: 7,
          langHint: this.config.langHint,
          onStep: (evt) => {
            if (evt.type === 'tool_call') {
              this.config.onStep?.({ type: 'tool_call', tool: `precise>${evt.tool}` });
            }
          },
        });
        if (this.trace) {
          sub.trace = this.initSubTrace(this.trace, 'PreciseSearchAgent', tc.id);
        }
        return sub.runSingle({
          originalName,
          searchGuidance: typeof item.searchGuidance === 'string' ? item.searchGuidance : undefined,
        });
      }

      case 'dispatchGlassDoorCalc': {
        const models = Array.isArray(args.cabinetModels) ? args.cabinetModels : [];
        if (models.length === 0) return 'dispatchGlassDoorCalc: cabinetModels 为空或格式错误';
        const sub = new GlassDoorAgent(this.llm, {
          searchBudgetLimit: 2,
          maxRounds: 4,
          langHint: this.config.langHint,
          onStep: (evt) => {
            if (evt.type === 'tool_call') {
              this.config.onStep?.({ type: 'tool_call', tool: `glassdoor>${evt.tool}` });
            }
          },
        });
        if (this.trace) {
          sub.trace = this.initSubTrace(this.trace, 'GlassDoorAgent', tc.id);
        }
        return sub.runCalc(models);
      }

      // ---- 搜索工具（补漏） ----

      case 'searchSkuShape':
        return executeSearchSkuShape(args);

      case 'searchSkuDescription':
        return executeSearchSkuDescription(args);

      case 'searchSkuStructured':
        return executeSearchSkuStructured(args);

      // ---- 清单编辑工具 ----

      case 'readParsedItems':
        return executeReadParsedItems(ctx.manifest);

      case 'addItem':
        return executeAddItem(ctx.manifest, args);

      case 'deleteItem':
        return executeDeleteItem(ctx.manifest, args);

      case 'editItemCell':
        return executeEditItemCell(ctx.manifest, args);

      // ---- 产品查询工具 ----

      case 'lookupItemComponents':
        return executeLookupItemComponents(args);

      default:
        return `未知工具: ${tc.function.name}`;
    }
  }

  // ================================================================
  //  Public API
  // ================================================================

  async parse(args: {
    input: string;
    colorHints?: string[];
    lang?: string;
    notes?: ChatNote[];
    fromImage?: boolean;
  }): Promise<{
    items: ParsedItem[];
    reply: string;
  }> {
    const langHint = args.lang === 'en' ? '英文' : '中文';
    (this.config as { langHint: string }).langHint = langHint;

    const inputLines = args.input
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const colorHintText = this.buildColorHintsText(args.colorHints, langHint);

    const manifest: MutableManifest = {
      items: [],
      products: [],
    };

    const context: TableParseAgentContext = {
      manifest,
      inputLines,
      notes: args.notes,
      fromImage: !!args.fromImage,
    };

    const systemPrompt = this.buildPrompt(langHint, args.notes || [], !!args.fromImage);

    const userMessage = `${colorHintText}请解析以下清单：\n\n\`\`\`\n${args.input}\n\`\`\``;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const result = await this.run(messages, context);

    // 保存全量对话日志（含 system / user / assistant / tool 全量消息）
    if (config.chatLog) {
      writeChatLog(result.messages);
    }

    // 将 status / colorIgnored / shapeSizeIgnored 写入每个 item（共享函数）
    computeExposedStatus(manifest.items);

    return {
      items: manifest.items as ParsedItem[],
      reply: result.reply || '解析完成。',
    };
  }

  // ================================================================
  //  Private helpers
  // ================================================================

  private parseArgs(raw: string | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private buildColorHintsText(
    colorHints: string[] | undefined,
    langHint: string,
  ): string {
    if (!colorHints || colorHints.length === 0) return '';
    return (
      `用户提示可能涉及以下颜色（用户使用${langHint}）: ${colorHints
        .map((code: string) => {
          const found = getColorEntries().find(
            (c) => c.code === code,
          );
          return found ? `${found.name} (${code})` : code;
        })
        .join(', ')}\n\n`
    );
  }

  private buildPrompt(
    langHint: string,
    notes: Array<{ originalName: string; content: string }> = [],
    fromImage: boolean = false,
  ): string {
    let notesSection = '';
    if (notes.length > 0) {
      const notesList = notes
        .map((n) => `- ${n.originalName}：${n.content}`)
        .join('\n');
      notesSection = `
## 已有笔记（产品型号映射参考）

以下是从过往对话中记录的产品型号映射笔记，解析清单时可将这些映射作为重要参考：

${notesList}
`;
    }

    const fromImageNote = fromImage
      ? `
> ⚠️ **重要提醒**：以下清单文本是由图片视觉识别 agent 自动生成的，可能包含 OCR 识别错误。对于用 \`?\` 标记了不确定字符或标注了不确定的行，请优先调用搜索工具重新验证。
`
      : '';

    return `你是一个 DUKO 橱柜清单解析编排助手。用户会粘贴一份物品清单，你需要：
1. 逐行理解清单内容
2. 将物品分批委派给搜索子 agent 在数据库中验证匹配
3. 对子 agent 搜索结果不满意或未找到的物品，亲自用搜索工具补漏
4. 通过清单编辑工具将每条物品写入清单（addItem / editItemCell / deleteItem）
5. 当搜索结果有多个候选时（置信度 medium/low），将候选值一并写入清单字段，供用户在界面上选择。不要在没有充分把握时强行只选一个
6. 最终生成一条简短的文字总结

## 产品代码规则

- itemName 格式为 {颜色代码}{形状代码}{尺寸代码}，如 "02B15" = 颜色02 + B型 + 15寸
- 形状代码常见值：B=Base(底柜), W=Wall(吊柜), ACM=Angled Crown Molding, TK=Toe Kick,
  UT=Utility, BTCR=Base Trash Can, BLS=Base Lazy Susan, VSB=Vanity Sink Base, ...

## 颜色代码对照表

| 代码 | 颜色名称 |
|------|---------|
${this.colorTable}

## 形状代码对照表

| 代码 | 描述 |
|------|------|
${this.shapeTypeTable}

## 概念解释

DUKO 除了售卖橱柜外，还售卖多种辅助板材和填空板(Filler)：

- WEP/BEP: 部分 Wall/Base Cabinet 的侧面出厂时没有颜色。这些橱柜若并排放置，最外两侧的露出的侧面则需要贴上与柜门相同颜色的板材，以维持视觉统一。
- PNL: 非常万能的板材。既可以用来覆盖单排橱柜作为岛台放置时，背后原本用来靠墙的没有颜色的面，也可以作为 Utility Pantry 这样很高的橱柜的侧面覆盖板。
- IEP: 部分橱柜的尺寸特殊，只能使用这张板材作为岛台背后的无颜色面的覆盖板。
- WF/BF/TF: 有些地方太窄，宽度只有 3 或者 6，无法容纳橱柜但又不能空着，因此需要 Filler 填补空隙；WF/BF/TF 的唯一区别是长度。
- RRP/DWP: 为了将冰箱、洗碗机等电器也与橱柜统一颜色风格的板材+Filler组合。本质上是放在电器两侧的带颜色的框架。

${notesSection}${fromImageNote}

## 委派搜索工具

### dispatchBatchSearch
将一批物品（最多 10 条）委派给 BatchSearchAgent。适用于信息较明确、批量搜索更高效的常规物品。
子 agent 将用 searchSkuShape / searchSkuDescription / searchSkuOverlap 对每项逐一搜索数据库。

子 agent 返回的 Markdown 表格中：
- 「匹配产品代码」列为最佳匹配，「备选产品代码」列为其他候选（逗号分隔）
- 当置信度为 **medium** 或 **low** 时，应读取备选产品代码列中的候选值，将它们写入清单对应字段（用逗号连接），而非只写首选
- 当置信度为 **high** 时，仅写入唯一匹配值即可

### dispatchPreciseSearch
将单条物品委派给 PreciseSearchAgent 做深度精确查询。适用于信息模糊、有歧义、需要多维度过滤的物品。
子 agent 使用 searchSkuStructured（编辑距离 + BM25 + 向量检索 + JSON 过滤树）做精确匹配。

子 agent 返回的结果中：
- 当列出「备选项」列表时，提取所有候选的产品代码，将它们连同最佳匹配一同写入清单字段
- 当置信度为 **medium** 或 **low** 时，读取备选产品代码列中的候选值，将它们写入清单对应字段
- 当置信度为 **high** 时，仅写入该唯一匹配

### dispatchGlassDoorCalc
如果客户要求玻璃门型号的橱柜而实际产品中没有，则需要基于普通橱柜定制玻璃门。
因此需要将对应普通橱柜型号委派给 GlassDoorAgent 计算出门的总数。
子 agent 会搜索每个型号的 otherDescription 字段，用 NLP 理解门数，汇总出总数。
注意：接收的是**普通橱柜**（如 Base Cabinet、Wall Cabinet），不是玻璃门型号（GD）。

## 自有搜索工具（补漏用）

- **searchSkuShape**：编辑距离模糊匹配形状代码 + 颜色
- **searchSkuDescription**：BM25 全文检索描述字段 + 颜色
- **searchSkuStructured**：结构化多维度检索（形状 JSON 过滤树 + 描述 JSON 过滤树 + 向量检索 + 颜色）

自有搜索工具与 dispatch 工具均计入工具预算，用完即不可再调用。

## 清单编辑工具

- **readParsedItems**：读取当前清单状态。多候选值的字段会以 " / " 分隔显示（如 "02 / 03 / 14"），定制要求列显示 door/box 或 -
- **addItem**：向清单中插入一条物品。**colorCode / shapeTypeCode / shapeSizeCode 可用逗号分隔传入多个候选值**（如 colorCode="02, 03, 14"），前端会自动显示为多选 radio 按钮供用户选择。当搜索结果有多个候选时，务必传入全部候选，不要只传入首选。customRequirement 可选，传入 "door" 表示该物品仅需柜门、传入 "box" 表示仅需柜体。**注意**：你可以在同一轮中并发发出任意数量的 addItem 调用（如 20 条物品一次性全部写入）
- **deleteItem**：从清单删除一行
- **editItemCell**：编辑指定行指定列。支持列：color、shapeType、shapeSize、customRequirement、quantity。value 同样支持逗号分隔的多候选值

## 产品查询工具

- **lookupItemComponents**：按完整型号查部件组成（柜门/主体/额外组件），供验证使用

## 工作流程

1. **审视清单**：阅读用户输入，理解每一行的含义，识别可能的颜色、形状、尺寸
2. **分批委派（并行）**：将物品按类型拆为多批，在同一轮工具调用中一次性发出所有 dispatchBatchSearch / dispatchPreciseSearch 请求。例如 20 条明确物品拆为 2 个 dispatchBatchSearch（各 ≤10 条）同时发出。dispatch 调用会并行执行——无相互依赖的查询不要逐批等待返回再发下一批。
3. **解读结果**：仔细检查子 agent 返回的置信度和备选项。对 high 置信度的直接采用；对 medium/low 置信度的，提取所有备选产品代码，拆分出各字段的候选值。必要时可再重复几轮并行分批委派步骤，比如用 dispatchPreciseSearch 针对性搜索 low/none 置信度的产品，把多个 medium/low 置信度对应的备选产品聚合起来再搜索，或者重试未正确返回结果的搜索。
4. **逐条写入清单**：使用 addItem 将每条物品写入 manifest（按原始顺序），用 editItemCell 填入匹配到的颜色/形状/尺寸/数量。**对有多个候选的字段，用逗号连接所有候选值传入**（如 shapeTypeCode="B, W, SB"），前端会自动显示为 radio 供用户选择
5. **补漏**：对委派结果不理想的物品，亲自使用 searchSkuShape / searchSkuDescription 搜索。自行搜索得到多个候选时同样以逗号分隔写入
6. **玻璃门计算**：如果清单中出现需要定制玻璃门的橱柜，调用 dispatchGlassDoorCalc 计算总门数，最后使用 addItem 把玻璃门定制服务也作为物品写到最后
7. **行数守恒**：输出的清单行数必须与输入的物品行数一致（非物品的注释行忽略不计），顺序严格对应。多行相同物品不合并，数量不累加
8. **生成总结**：最后用简短列表概括解析了多少项、找到多少项、需要多少玻璃门等，并提及有哪些物品存在多个候选需要用户确认

## 数量提取

从行文本中识别数量信息（如 "2x", "2-", "2 pcs", "(2)", "×2" 等），提取后从物品名称中去除数量标记。未提及数量默认为 1。

## 返回格式

最终回复为简短的自然语言总结，**包含对歧义物品的提醒**（如 "第 3 行有 3 个候选颜色，请在表格中选择"）。**不要**输出 JSON。清单数据通过 addItem / editItemCell 工具写入。
用户界面为${langHint}，用户可能使用${langHint}粘贴清单内容。`;
  }
}

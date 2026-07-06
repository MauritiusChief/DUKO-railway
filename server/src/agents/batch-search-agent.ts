/**
 * BatchSearchAgent —— 批量搜索子 agent
 *
 * 接收一批物品（≤10 条），对每项使用 searchSkuShape / searchSkuDescription /
 * searchSkuOverlap 在数据库中搜索匹配产品。LLM 可在同一轮中并发发起多个搜索，
 * 返回结构化的批量匹配结果。
 *
 * 由 TableParseAgent 通过 dispatchBatchSearch 工具委派调用。
 */

import { BaseAgent, type AgentContext, type BaseAgentConfig } from './base.js';
import type { ToolDefinition, ToolCall } from '../types/tool.js';
import type { ChatMessage } from '../types/message.js';
import type { LlmProvider } from '../llm/provider.js';
import { config } from '../config/env.js';
import { writeChatLog } from '../services/logger.js';

import {
  SEARCH_SKU_SHAPE_TOOL,
  executeSearchSkuShape,
} from '../tools/search-shape.js';

import {
  SEARCH_SKU_DESCRIPTION_TOOL,
  executeSearchSkuDescription,
} from '../tools/search-description.js';

import {
  SEARCH_SKU_OVERLAP_TOOL,
  executeSearchSkuOverlap,
} from '../tools/search-overlap.js';
import { ToolName } from '../tools/index.js';

// ==================================================================
//  BatchSearchAgent
// ==================================================================

export class BatchSearchAgent extends BaseAgent<ChatMessage> {
  static override ownedToolNames = [
    'searchSkuShape',
    'searchSkuDescription',
    'searchSkuOverlap',
  ];

  constructor(llm: LlmProvider<ChatMessage>, config: BaseAgentConfig) {
    super(llm, config);
  }

  getSystemPrompt(): string {
    return '';
  }

  getTools(): ToolDefinition[] {
    return [
      SEARCH_SKU_SHAPE_TOOL,
      SEARCH_SKU_DESCRIPTION_TOOL,
      SEARCH_SKU_OVERLAP_TOOL,
    ];
  }

  getBudgetedToolNames(): Set<ToolName> {
    // 所有搜索工具均消耗预算
    return new Set([
      'searchSkuShape',
      'searchSkuDescription',
      'searchSkuOverlap',
    ]);
  }

  protected async executeTool(
    tc: ToolCall,
    _context: AgentContext,
  ): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      // 参数解析失败，使用空对象
    }

    switch (tc.function.name) {
      case 'searchSkuShape':
        return executeSearchSkuShape(args);
      case 'searchSkuDescription':
        return executeSearchSkuDescription(args);
      case 'searchSkuOverlap':
        return executeSearchSkuOverlap(args);
      default:
        return `未知工具: ${tc.function.name}`;
    }
  }

  // ================================================================
  //  Public API
  // ================================================================

  /**
   * 批量搜索一批物品，返回 Markdown 格式的匹配结果表。
   *
   * @param batch 物品列表（每项至少含 identifier，可选 hint 字段）
   * @returns Markdown 结果文本
   */
  async runBatch(
    batch: Array<{
      identifier: string;
      colorCodeHint?: string;
      shapeTypeCodeHint?: string;
      shapeSizeCodeHint?: string;
      descriptionHint?: string;
    }>,
  ): Promise<string> {
    if (!batch || batch.length === 0) {
      return '## 批量搜索结果\n\n**无待搜索项。**';
    }

    const itemsList = batch
      .map(
        (item, i) =>
          `${i + 1}. ${item.identifier}` +
          (item.colorCodeHint ? ` [颜色提示: ${item.colorCodeHint}]` : '') +
          (item.shapeTypeCodeHint ? ` [形状提示: ${item.shapeTypeCodeHint}]` : '') +
          (item.shapeSizeCodeHint ? ` [尺寸提示: ${item.shapeSizeCodeHint}]` : '') +
          (item.descriptionHint ? ` [描述: ${item.descriptionHint}]` : ''),
      )
      .join('\n');

    const systemPrompt =
      `你是一个 DUKO 橱柜产品批量搜索助手。你的任务是对一批物品逐一在数据库中搜索匹配的产品。
  
  ## 可用工具
  
  - **searchSkuShape**：按形状类型代码 + 尺寸代码模糊匹配（编辑距离 ≤ ceil(len/2)）。适合已知型号代码的场景。
  - **searchSkuDescription**：按自然语言描述 BM25 全文检索。适合只有描述没有代码的场景。
  - **searchSkuOverlap**：形状匹配 + 描述检索取交集。适合同时有型号和描述的复杂场景。
  
  ## 搜索策略
  
  1. 对每个物品选择合适的工具：
     - 有明确型号代码 → searchSkuShape
     - 只有自然语言描述 → searchSkuDescription
     - 两者都有 → searchSkuOverlap
  2. 可在一轮中并发发起多个搜索（提高效率）
  3. 颜色提示（如 "02"）可通过 colorCode 参数筛选；无提示则使用 "*"
  4. 没有结果的项标记为 "未找到"
  5. **关键**：当搜索结果存在多个候选匹配时（置信度 medium/low），不要只返回首选，必须在「备选产品代码」列中列出其他排名靠前的候选项（最多 5 个），让上层编排 Agent 能将这些候选值填入清单供用户选择。
  
  ## 输出格式
  
  最终输出一个 Markdown 表格：
  
  | # | 原始标识 | 匹配产品代码 | 备选产品代码 | 匹配方式 | 颜色 | 形状 | 尺寸 | 主描述 | 置信度 |
  |---|---------|-------------|-------------|---------|------|------|------|-------|--------|
  | 1 | xxx | 02B15 | 03B18, 04B21 | shape | 02 | B | 15 | Base Cabinet | high |
  
  - **匹配产品代码**：最佳匹配的产品代码
  - **备选产品代码**：其他排名靠前的候选产品代码，用逗号分隔。high 置信度（唯一明确匹配）时填 "-"；medium/low 时务必列出其余候选
  - **置信度**：high（唯一明确匹配）/ medium（多个候选，此为首选）/ low（模糊匹配）/ none（未找到）
  用${this.config.langHint}回复。`;

    const userMessage = `请对以下 ${batch.length} 项物品进行批量搜索：\n\n${itemsList}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const result = await this.run(messages, {});
    if (config.chatLog) {
      writeChatLog(result.messages);
    }
    return result.reply || '## 批量搜索结果\n\n搜索未能返回有效结果。';
  }
}

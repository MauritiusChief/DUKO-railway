/**
 * PreciseSearchAgent —— 精确深度搜索子 agent
 *
 * 接收单条物品 + 查询指导，使用 searchSkuStructured 工具进行多维度精确检索。
 * searchSkuStructured 支持 JSON 过滤树表达并/交/补集操作，叶子节点分别用
 * 编辑距离（形状匹配）和 BM25（描述匹配）求值，外加向量语义检索。
 *
 * 由 TableParseAgent 通过 dispatchPreciseSearch 工具委派调用。
 * 每次处理 1 条物品，预算 5 轮搜索。
 */

import { BaseAgent, type AgentContext, type BaseAgentConfig } from './base.js';
import type { ToolDefinition, ToolCall } from '../types/tool.js';
import type { ChatMessage } from '../types/message.js';
import type { LlmProvider } from '../llm/provider.js';
import { config } from '../config/env.js';
import { writeChatLog } from '../services/logger.js';

import {
  SEARCH_SKU_STRUCTURED_TOOL,
  executeSearchSkuStructured,
} from '../tools/search-structured.js';
import { ToolName } from '../tools/index.js';

// ==================================================================
//  PreciseSearchAgent
// ==================================================================

export class PreciseSearchAgent extends BaseAgent<ChatMessage> {
  static override ownedToolNames = ['searchSkuStructured'];

  constructor(llm: LlmProvider<ChatMessage>, config: BaseAgentConfig) {
    super(llm, config);
  }

  getSystemPrompt(): string {
    return '';
  }

  getTools(): ToolDefinition[] {
    return [SEARCH_SKU_STRUCTURED_TOOL];
  }

  getBudgetedToolNames(): Set<ToolName> {
    return new Set(['searchSkuStructured']);
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

    if (tc.function.name === 'searchSkuStructured') {
      return executeSearchSkuStructured(args);
    }
    return `未知工具: ${tc.function.name}`;
  }

  // ================================================================
  //  Public API
  // ================================================================

  /**
   * 对单条物品进行深度精确搜索。
   *
   * @param item 物品信息（原始名称 + 查询指导）
   * @returns Markdown 格式的精确匹配结果
   */
  async runSingle(item: {
    originalName: string;
    searchGuidance?: string;
  }): Promise<string> {
    const guidanceText = item.searchGuidance
      ? `\n\n## 查询指导\n\n${item.searchGuidance}`
      : '';

    const systemPrompt =
      `你是一个 DUKO 橱柜产品精确搜索助手。你的任务是对单条物品进行深度多维度搜索。
  
  ## 可用工具
  
  - **searchSkuStructured**：结构化多维度精确检索。支持四个独立过滤维度：
    1. **shapeFilter**（JSON 过滤树）：编辑距离模糊匹配形状代码，等价 searchSkuShape
       - 叶子节点：{"shapeTypeCode":"GD"} 或 {"shapeTypeCode":"B","shapeSizeCode":"15"}
       - 运算符：{"operator":"or","conditions":[...]} / {"operator":"and","conditions":[...]} / {"operator":"not","condition":{...}}
       - "*" 通配符表示不限制该维度
    2. **descriptionFilter**（JSON 过滤树）：BM25 全文检索描述字段，等价 searchSkuDescription
       - 叶子节点：{"text":"corner cabinet"}
    3. **vectorQuery**（字符串）：向量语义检索
    4. **colorCode**（字符串）：颜色限定，"*" 为通配符
  
  ## 搜索策略
  
  1. 根据物品的已知信息和查询指导，分步构建精确的过滤条件：
     - 先确定颜色（colorCode）
     - 再构建形状过滤（shapeFilter）
     - 如有自然语言描述，补充 descriptionFilter
     - 如仍不确定，补充 vectorQuery 做语义搜索
  2. 如果首次搜索结果不够精确，迭代调整过滤树的结构（增加 and 约束或调整编辑距离范围）
  3. 最终确认最匹配的结果
  
  ## 输出格式
  
  最终输出产品匹配结果，包含：
  - **最佳匹配**：产品代码 + 主描述 + 匹配方式
  - **置信度**：high（唯一明确）/ medium（多个候选）/ low（模糊）/ none（未找到）
  - **备选项**（当置信度不为 high 时必须输出）：列出其他排名靠前的候选产品，格式为：

    备选项：
    - 03B15 — Base Cabinet 15in（颜色不同）
    - 02B18 — Base Cabinet 18in（尺寸不同）
    - 02B21 — Base Cabinet 21in（尺寸不同）

    每个备选标注其与最佳匹配的主要差异。最多列出 5 条。
  
  **重要**：当搜索结果的唯一性不足时，务必列出备选项，让上层编排 Agent 能将这些候选值填入清单供用户选择。不要在没有充分把握的情况下强行输出 high 置信度。
  
  用${this.config.langHint}回复。`;

    const userMessage = `请对以下物品进行精确搜索：**${item.originalName}**${guidanceText}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const result = await this.run(messages, {});
    if (config.chatLog) {
      writeChatLog(result.messages);
    }
    return result.reply || `## 精确搜索结果\n\n对 "${item.originalName}" 的搜索未能返回有效结果。`;
  }
}

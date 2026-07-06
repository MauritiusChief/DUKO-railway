/**
 * GlassDoorAgent —— 玻璃门切割总数计算子 agent
 *
 * 接收一组普通橱柜型号（非玻璃门型号），在数据库中查找每个型号的
 * otherDescription 字段，通过 LLM 自然语言理解提取门数，汇总得出
 * 需要定制玻璃门的总数。
 *
 * 适用场景：客户选购的橱柜本身不包含玻璃门，但想额外定制玻璃门时，
 * 通过此 Agent 计算出总共需要切割多少扇玻璃门。
 *
 * 由 TableParseAgent 通过 dispatchGlassDoorCalc 工具委派调用。
 * 预算 2 轮搜索。
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
import { ToolName } from '../tools/index.js';

// ==================================================================
//  GlassDoorAgent
// ==================================================================

export class GlassDoorAgent extends BaseAgent<ChatMessage> {
  static override ownedToolNames = ['searchSkuShape'];

  constructor(llm: LlmProvider<ChatMessage>, config: BaseAgentConfig) {
    super(llm, config);
  }

  getSystemPrompt(): string {
    return '';
  }

  getTools(): ToolDefinition[] {
    return [SEARCH_SKU_SHAPE_TOOL];
  }

  getBudgetedToolNames(): Set<ToolName> {
    return new Set(['searchSkuShape']);
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

    if (tc.function.name === 'searchSkuShape') {
      return executeSearchSkuShape(args);
    }
    return `未知工具: ${tc.function.name}`;
  }

  // ================================================================
  //  Public API
  // ================================================================

  /**
   * 计算一组橱柜型号的玻璃门切割总数。
   *
   * @param cabinetModels 橱柜型号列表（每项含 shapeTypeCode，可选 shapeSizeCode/colorCodeHint/quantity）
   * @returns Markdown 格式的门数计算结果（总数 + 明细表）
   */
  async runCalc(
    cabinetModels: Array<{
      shapeTypeCode: string;
      shapeSizeCode?: string;
      colorCodeHint?: string;
      quantity?: number;
    }>,
  ): Promise<string> {
    if (!cabinetModels || cabinetModels.length === 0) {
      return '## 玻璃门计算结果\n\n**无待计算项。**';
    }

    const modelsList = cabinetModels
      .map(
        (m, i) =>
          `${i + 1}. shapeTypeCode=${m.shapeTypeCode}` +
          (m.shapeSizeCode ? `, shapeSizeCode=${m.shapeSizeCode}` : '') +
          (m.colorCodeHint ? `, 颜色=${m.colorCodeHint}` : '') +
          `, 数量=${m.quantity ?? 1}`,
      )
      .join('\n');

    const systemPrompt =
      `你是一个 DUKO 橱柜玻璃门计算助手。你的任务是计算一组普通橱柜各自有**几扇门**，
  从而汇总出需要定制玻璃门的总数。

  ## 工作方式

  使用 **searchSkuShape** 工具搜索每个橱柜型号：
  - shapeTypeCode：橱柜的形状型号（如 "B"、"W"、"SB"）
  - shapeSizeCode：橱柜的尺寸代码（如 "15"、"18"）。如果没提供，用 "*"
  - colorCode：颜色限定（如 "02"）。没提供则用 "*"
  - topK：默认 10

  ## 门数提取

  搜索结果中每条记录都有一个 **otherDescription** 字段，这是自然语言文本。
  你需要从中**理解**该橱柜有几扇门。例如：
  - "2 doors"、"double door" → 2 门
  - "single door"、"1 door" → 1 门  
  - "4 doors" → 4 门
  - 如果 otherDescription 中未明确提及门数，标注 "无法确定"

  ## 输出格式

  最终输出 Markdown 汇总表：

  | # | 查询型号 | 数量 | 每件门数 | 小计（门数×数量） | 判断依据 |
  |---|---------|------|---------|------------------|---------|
  | 1 | B-15 | 2 | 2门 | 4 | otherDescription: "Base Cabinet, 2 doors" |
  | 2 | W-18 | 1 | 1门 | 1 | otherDescription: "single door Wall Cabinet" |
  | **合计** | | | | **5 门** | |

  用${this.config.langHint}回复。`;

    const userMessage =
      `请计算以下 ${cabinetModels.length} 个橱柜型号各自的门数并汇总：\n\n${modelsList}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const result = await this.run(messages, {});
    if (config.chatLog) {
      writeChatLog(result.messages);
    }
    return result.reply || '## 玻璃门计算结果\n\n计算未能返回有效结果。';
  }
}

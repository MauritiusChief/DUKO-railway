/**
 * ImageParseAgent —— 图片清单解析 Agent（视觉多模态）
 *
 * 接收 base64 编码的图片，调用 OpenRouter 视觉模型解析橱柜清单，
 * 使用 searchSkuShape / searchSkuDescription 工具验证产品。
 * 返回纯文本，供后续 MainAgent 解析为结构化 JSON 表格。
 */

import { BaseAgent, type AgentContext, type BaseAgentConfig } from './base.js';
import type { ToolDefinition, ToolCall } from '../types/tool.js';
import type { MultimodalChatMessage, MultimodalContent } from '../types/message.js';
import type { LlmProvider } from '../llm/provider.js';
import type { ChatNote } from '../types/manifest.js';

import {
  SEARCH_SKU_SHAPE_TOOL,
  executeSearchSkuShape,
} from '../tools/search-shape.js';

import {
  SEARCH_SKU_DESCRIPTION_TOOL,
  executeSearchSkuDescription,
} from '../tools/search-description.js';

import { getColorTable, getColorEntries } from '../services/utils.js';
import { config } from '../config/env.js';
import { writeChatLog } from '../services/logger.js';
import { ToolName } from '../tools/index.js';

// ==================================================================
//  ImageParseAgent
// ==================================================================

export class ImageParseAgent extends BaseAgent<MultimodalChatMessage> {
  /** 本 Agent 拥有的全部工具名 */
  static override ownedToolNames = [
    'searchSkuShape',
    'searchSkuDescription',
  ];

  constructor(llm: LlmProvider<MultimodalChatMessage>, config: BaseAgentConfig) {
    super(llm, config);
  }

  getSystemPrompt(): string {
    return '';
  }

  getTools(): ToolDefinition[] {
    return [SEARCH_SKU_SHAPE_TOOL, SEARCH_SKU_DESCRIPTION_TOOL];
  }

  getBudgetedToolNames(): Set<ToolName> {
    return new Set(['searchSkuShape', 'searchSkuDescription']);
  }

  protected async executeTool(
    tc: ToolCall,
    _context: AgentContext,
  ): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      console.warn('[ImageParseAgent] 工具参数解析出错');
    }

    if (tc.function.name === 'searchSkuShape') {
      return executeSearchSkuShape(args);
    }
    if (tc.function.name === 'searchSkuDescription') {
      return executeSearchSkuDescription(args);
    }
    return `未知工具: ${tc.function.name}`;
  }

  /** 剥离 LLM 包裹的 Markdown 代码块标记 */
  protected postprocessReply(reply: string): string {
    return reply
      .replace(/^```[\w]*\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
  }

  // ================================================================
  //  Public API
  // ================================================================

  async parse(args: {
    images: string[];
    colorHints?: string[];
    lang?: string;
    notes?: ChatNote[];
  }): Promise<string> {
    const langHint = args.lang === 'en' ? '英文' : '中文';
    (this.config as { langHint: string }).langHint = langHint;

    const colorHintText =
      args.colorHints && args.colorHints.length > 0
        ? `用户提示可能涉及以下颜色: ${args.colorHints
            .map((code) => {
              const found = getColorEntries().find((c) => c.code === code);
              return found ? `${found.name} (${code})` : code;
            })
            .join(', ')}`
        : '';

    const userTextContent = `${colorHintText ? colorHintText + '\n\n' : ''}请识别并解析以上${args.images.length > 1 ? ` ${args.images.length} 张` : ''}图片中的橱柜清单，使用${langHint}输出。`;

    // 构建用户消息：文本 + 所有图片
    const imageContents: Array<{ type: 'image_url'; image_url: { url: string; detail?: 'high' } }> = args.images.map((img) => ({
      type: 'image_url' as const,
      image_url: { url: img, detail: 'high' as const },
    }));

    const messages: MultimodalChatMessage[] = [
      {
        role: 'system',
        content: this.buildPrompt(langHint, args.notes || []),
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: userTextContent },
          ...imageContents,
        ],
      },
    ];

    const result = await this.run(messages);

    if (config.chatLog) {
      writeChatLog(result.messages);
    }

    if (!result.reply) {
      throw new Error('视觉模型未能从图片中识别出任何物品。请确保图片清晰且包含橱柜清单信息。');
    }

    return result.reply;
  }

  // ================================================================
  //  Private helpers
  // ================================================================

  private buildPrompt(
    langHint: string,
    notes: Array<{ originalName: string; content: string }> = [],
  ): string {
    const colorTable = getColorTable();

    let notesSection = '';
    if (notes.length > 0) {
      const notesList = notes.map((n) => `- ${n.originalName}：${n.content}`).join('\n');
      notesSection = `
## 已有笔记（产品型号映射参考）

以下是从过往对话中记录的产品型号映射笔记，解析图片时可作为重要参考：

${notesList}
`;
    }

    return `你是一个 DUKO 橱柜产品图片解析助手。用户会提供一张橱柜报价清单的截图或照片，
你的任务是从图片中识别出所有橱柜物品的产品代码和数量。${notesSection}

## 输出格式

你必须将识别结果按以下格式输出，**每行一项物品**：

[颜色代码][形状型号代码][尺寸代码] - Qty: [数量]

示例：

02B12 - Qty: 2
02W3012 - Qty: 1
14B15 - Qty: 3

- 颜色代码填两位数字
- 形状型号只填代码（如 "B"、"W"、"UT"、"BLS"），不要填描述
- 尺寸代码填数字（如 "15"、"18F"、"3012"）
- Qty 填数字
- 图片中的每一项都必须单独占一行，即使多行完全相同也不可合并

## 颜色代码对照表

| 代码 | 颜色名称 |
|------|---------|
${colorTable}

## 产品代码规则

- itemName 格式为 {颜色代码}{形状代码}{尺寸代码}，如 "02B15" = 颜色02 + B型 + 15寸
- 形状代码常见值：B=Base(底柜), W=Wall(吊柜), ACM=Angled Crown Molding, TK=Toe Kick,
  UT=Utility, BTCR=Base Trash Can, BLS=Base Lazy Susan, VSB=Vanity Sink Base, ...
- 尺寸代码：数字表示宽度（英寸），如 "15"=15寸, "18"=18寸, "361824"=36"W × 18"H × 24"D

## 使用 searchSkuShape / searchSkuDescription 工具

- **搜索工具仅用于获取 DUKO 产品数据库中的例子作为参照**，帮助你了解产品代码的格式、规律和常见值。
- **搜索结果是参照，不是答案。** 图片中看到什么代码就输出什么代码，不要用搜索结果的 itemName 去"纠正"或"覆盖"你在图片中看到的内容。
- **原则：能清晰辨认就不搜索。** 图片中能清晰无误读出的代码，直接输出。
- 仅在以下情况调用搜索工具：
  - 手写文字或图片质量导致字符完全无法辨认
  - 图片被遮挡、反光导致部分代码无法辨认
  - 图片中只有自然语言描述（如 "白色底柜"）而没有产品代码，需要看 DUKO 类似产品的格式作为参照
- searchSkuShape：按形状类型/尺寸代码模糊匹配（编辑距离），shapeTypeCode 必填，colorCode 填 "*" 或颜色代码
- searchSkuDescription：按英文描述检索 desc 字段，query 填英文描述，colorCode 必填
- 如果是具体产品代码拼接 → 优先用 searchSkuShape
- 如果是自然语言描述 → 优先用 searchSkuDescription

## 不确定内容的处理

- 无法辨认的字符用 \`?\` 代替，**不要猜测或列出可能的值**。
- 示例：
  02B1? - Qty: 2
- 完全无法辨认的产品，输出尽可能多的可见信息并注明不确定，不要虚构。

## 工作流程

1. 仔细观察图片中的所有内容，逐一列出每项橱柜物品
2. 能清晰读出的代码 → 直接按格式输出
3. 完全无法辨认时 → 搜索 DUKO 数据库作为参照，了解产品代码格式和规律
4. 你可以在一轮中并行发起多个搜索调用
5. 最终输出必须是纯文本格式，每行一项`;
  }
}

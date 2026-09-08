/**
 * ImageParseAgent —— 图片清单解析 Agent（视觉多模态）
 *
 * 接收 base64 编码的图片，调用 OpenRouter 视觉模型解析橱柜清单，
 * 使用 searchSkuShape / searchSkuDescription 工具验证产品。
 * 返回纯文本，供后续 TableParseAgent 解析为结构化 JSON 表格。
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
你的任务是从图片中识别出打印或手写的橱柜物品的产品字符和数字。${notesSection}

## 输出格式

**以图片原文为准**：
- 图片写的是什么格式，就按原样输出
- 图片写的是自然语言描述（如 "白色底柜"），就原样输出该描述，并附上可见数量
- 看不到的部分用 \`?\` 占位

## 使用 searchSkuShape / searchSkuDescription 工具（辅助辨认模糊字符）

searchSkuShape 和 searchSkuDescription 帮助你完成视觉转录任务中的一项特定工作：确认模糊字符的字形。

**适用场景**：图片中的某个字符轮廓不清（字体怪异、笔迹潦草、遮挡、反光），你无法确定它具体是什么字。此时可以搜索 DUKO 数据库，看是否存在包含相似字符组合的型号，帮你判断那个模糊的笔画到底是哪个字符。

**不属于本工具的场景（请交给下游）**：
- 图片中写的是自然语言描述（如 "白色底柜"）而非产品代码 → 如实输出你看到的文字，后续会处理自然语言匹配
- 代码的某一部分被完全遮挡或裁切，看不到任何笔画 → 该位用 \`?\` 标记即可
- 图片中内容清晰可读，但你怀疑它和数据库对不上 → 仍然输出你看到的字符。产品验证是下游的工作

**原则**：搜索结果只用于帮你"看清那个字写的什么"，不用于帮你"判断那个位置应该放什么产品"。

- searchSkuShape：按形状类型/尺寸代码模糊匹配（编辑距离），shapeTypeCode 必填，colorCode 填 "*" 或颜色代码
- searchSkuDescription：按英文描述检索 desc 字段，query 填英文描述，colorCode 必填

## 不确定内容的处理

- 无法辨认的字符用 \`?\` 代替，并或列出可能的字符。
- 完全无法辨认的产品，输出尽可能多的可见信息并注明不确定，不要虚构。

## 工作流程

1. 仔细观察图片，逐一列出每项物品
2. 能清晰读出的代码 → 直接输出
3. 有模糊字符 → 用 \`?\` 标记模糊位，必要时搜索数据库辅助确认字形
4. 同一轮中可并行发起多个搜索调用
5. 最终输出纯文本，每行一项`;
  }
}

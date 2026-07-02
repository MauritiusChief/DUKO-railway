/**
 * LayoutAgent —— 厨房布局图片识别 Agent（视觉多模态）
 *
 * 接收 base64 图片 + 当前布局，调用 OpenRouter 视觉模型识别布局。
 * LLM 通过 function calling 自主调用布局工具和搜索工具对布局进行增量修改。
 */

import { BaseAgent, type AgentContext, type BaseAgentConfig } from './base.js';
import type { ToolDefinition, ToolCall } from '../types/tool.js';
import type { MultimodalChatMessage } from '../types/message.js';
import type { LlmProvider } from '../llm/provider.js';
import type { MutableLayout, LayoutDocument } from '../types/layout.js';
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
  LAYOUT_TOOLS,
  executeLayoutTool,
} from '../tools/layout.js';
import { ToolName } from '../tools/index.js';

// ==================================================================
//  LayoutAgent 专用上下文
// ==================================================================

export interface LayoutAgentContext extends AgentContext {
  mutableLayout: MutableLayout;
  viewType: string;
  associatedWallNames: string[];
}

// ==================================================================
//  LayoutAgent
// ==================================================================

export class LayoutAgent extends BaseAgent<MultimodalChatMessage> {
  /** 本 Agent 拥有的全部工具名 */
  static override ownedToolNames = [
    'readLayout',
    'createWall',
    'deleteWall',
    'insertItem',
    'deleteItem',
    'insertItemAtPosition',
    'updateWallProperties',
    'connectWalls',
    'disconnectWalls',
    'connectIslands',
    'disconnectIslands',
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
    return [...LAYOUT_TOOLS, SEARCH_SKU_SHAPE_TOOL, SEARCH_SKU_DESCRIPTION_TOOL];
  }

  getBudgetedToolNames(): Set<ToolName> {
    return new Set(['searchSkuShape', 'searchSkuDescription']);
  }

  protected async executeTool(
    tc: ToolCall,
    context: AgentContext,
  ): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      console.warn(`[LayoutAgent] ${tc.function.name} 参数解析出错`);
    }

    if (tc.function.name === 'searchSkuShape') {
      return executeSearchSkuShape(args);
    }
    if (tc.function.name === 'searchSkuDescription') {
      return executeSearchSkuDescription(args);
    }

    // 布局工具
    const ctx = context as LayoutAgentContext;
    return executeLayoutTool(ctx.mutableLayout, tc.function.name, args);
  }

  // ================================================================
  //  Public API
  // ================================================================

  async parse(args: {
    image: string;
    viewType?: string;
    associatedWallIds?: string[];
    layout: LayoutDocument;
  }): Promise<LayoutDocument> {
    const viewType = args.viewType || 'top';
    const associatedWallIds: string[] = Array.isArray(args.associatedWallIds)
      ? args.associatedWallIds
      : [];

    const associatedNames: string[] = [];
    for (const id of associatedWallIds) {
      const w = args.layout.walls.find((w) => w.id === id);
      if (w) associatedNames.push(w.name);
    }

    const mutableLayout: MutableLayout = { layout: args.layout };

    const messages: MultimodalChatMessage[] = [
      {
        role: 'system',
        content: this.buildPrompt(viewType, associatedNames),
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请识别这张图片中的橱柜布局，并更新当前布局使其与图片一致。' },
          { type: 'image_url', image_url: { url: args.image, detail: 'high' } },
        ],
      },
    ];

    const context: LayoutAgentContext = {
      mutableLayout,
      viewType,
      associatedWallNames: associatedNames,
    };

    const result = await this.run(messages, context);

    if (config.chatLog) {
      writeChatLog(result.messages);
    }

    return mutableLayout.layout;
  }

  // ================================================================
  //  Private helpers
  // ================================================================

  private buildPrompt(viewType: string, associatedNames: string[]): string {
    const wallHint = associatedNames.length > 0
      ? `此图描述以下墙: ${associatedNames.join(', ')}。`
      : '';

    return `你是一个厨房橱柜布局识别助手。你正在分析一张 ${viewType} 视图的图片。
${wallHint}

## 布局数据模型

一个布局包含若干墙（wall）。每面墙有两个轨道：
- **airBlocks**（空中轨道）：吊柜(wall_cabinet)、高柜(tall_cabinet)、空挡(gap)、抽油烟机(range_hood)、窗户(window)、通天电器(tall_appliance)及其叠放吊柜
- **groundBlocks**（地面轨道）：地柜(base_cabinet)、高柜(tall_cabinet)、空挡(gap)、通天电器(tall_appliance)、需台面电器(base_appliance_need_top)、免台面电器(base_appliance_without_top)

全高物品（tall_cabinet/tall_appliance）同时在 air 和 ground 两轨各有一个 block，共享同一个 item ID。
墙吊柜（wall_cabinet）和全高物品的 air 块支持多个物品堆叠（stackedSkus）。

岛台是一种特殊的墙。通过 backToBackIslandIds 表示背靠背关系。
connectedWallIds 表示 L 形转角连接关系。connectIslands 用于设置背靠背关系，connectWalls 用于设置转角连接。

## 物品分类说明

| 分类 | 含义 | 轨道 |
|------|------|------|
| wall_cabinet | 吊柜 | air |
| base_cabinet | 地柜 | ground |
| tall_cabinet | 通天高柜 | air + ground |
| gap | 空挡 | air 或 ground |
| range_hood | 抽油烟机 | air |
| window | 窗户 | air |
| tall_appliance | 通天电器（冰箱等） | air + ground |
| base_appliance_need_top | 需台面电器（洗碗机等） | ground |
| base_appliance_without_top | 免台面电器（灶台等） | ground |

## 工作流程

1. **首先**调用 readLayout 了解当前布局状态
2. 对照图片中的橱柜排列，使用 insertItem 添加图片中看到但布局中缺失的物品
3. **仅对关联墙上的物品进行修改**。图片可能只展示了部分区域，未关联的墙上的物品**保持不变**
4. 对于关联墙上的已有物品：**优先保留**，仅当你能 100% 确定图片中的排列与之明确矛盾时才使用 deleteItem 删除
5. 使用 updateWallProperties 修正关联墙的宽度、暴露面属性
6. 使用 connectWalls 建立 L 形墙连接关系，使用 connectIslands 建立岛台背靠背关系
7. 使用 createWall 添加新墙/岛台
8. 使用 searchSkuShape、searchSkuDescription 验证产品代码是否存在于 DUKO 数据库中

## 重要规则

- **所有物品必须指定 SKU**。柜体填 DUKO 产品代码（如 "02B15"），
  非柜体填具体名称（如 "refrigerator"、"range_hood"），
  空挡填 "gap"。
- **宽度单位为英寸**。根据图片中物品的相对比例估算宽度。
- **位置由系统自动管理**。使用 insertItem 时物品自动排到最左侧，
  不需要手动指定距离。仅在需要精确定位时使用 insertItemAtPosition。
- **此图片仅展示关联墙的部分视角**。关联墙之外的其他墙上的物品，不要新增也不要删除。
- **同一布局可能由多张不同视角/区域的图片逐步完善**。本次请求仅处理当前图片呈现的信息。
- **readLayout 会显示当前所有物品及其位置**，便于你判断哪些需要增删。
- **修改后不需要再次 readLayout**，直接基于已知信息继续修改即可。
- **仅使用中文回复**，简洁告知用户做了哪些修改。`;
  }
}

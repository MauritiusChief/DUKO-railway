/**
 * LayoutAgent —— 厨房布局编排 Agent（文本编排）
 *
 * 接收 LayoutOcrAgent 产出的 initialOcrText + 当前布局，
 * 使用 DeepSeek 文本模型进行布局编排、SKU 查询调度、layout tools 修改。
 * 如发现 OCR 漏识别、宽度冲突等，通过 dispatchLayoutOcr 工具调用
 * OpenRouter 视觉模型进行二次 OCR 复查。
 *
 * 布局编辑工具串行执行避免状态竞态，dispatch 工具可并发执行。
 */

import { BaseAgent, type AgentContext, type BaseAgentConfig } from './base.js';
import type { ToolDefinition, ToolCall } from '../types/tool.js';
import type { ChatMessage } from '../types/message.js';
import type { MultimodalChatMessage } from '../types/message.js';
import type { LlmProvider } from '../llm/provider.js';
import type { MutableLayout, LayoutDocument } from '../types/layout.js';
import { config } from '../config/env.js';
import { writeChatLog } from '../services/logger.js';

/** 会修改布局的工具名集合 */
const LAYOUT_MUTATING_TOOLS = new Set([
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
]);

/** LayoutAgent 专用扩展配置（含 layout 更新回调） */
export interface LayoutAgentExtendedConfig extends BaseAgentConfig {
  /** 布局被工具修改后调用，推送新的 layout 快照 */
  onLayoutUpdated?: (event: {
    layout: LayoutDocument;
    tool: string;
    message: string;
  }) => void;
}

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

import {
  DISPATCH_BATCH_SEARCH_TOOL,
  DISPATCH_PRECISE_SEARCH_TOOL,
  DISPATCH_LAYOUT_OCR_TOOL,
} from '../tools/dispatch.js';

import { ToolName } from '../tools/index.js';
import { BatchSearchAgent } from './batch-search-agent.js';
import { PreciseSearchAgent } from './precise-search-agent.js';
import { LayoutOcrAgent, type LayoutOcrInput } from './layout-ocr-agent.js';
import { getShapeTypeTable, getColorTable } from '../services/utils.js';

// ==================================================================
//  LayoutAgent 专用上下文
// ==================================================================

export interface LayoutAgentContext extends AgentContext {
  mutableLayout: MutableLayout;
  viewType: string;
  associatedWallNames: string[];
  /** 原始图片 data URL（用于 dispatchLayoutOcr 二次 OCR） */
  image: string;
}

// ==================================================================
//  LayoutAgent
// ==================================================================

export class LayoutAgent extends BaseAgent<ChatMessage> {
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
    'dispatchLayoutOcr',
    'dispatchBatchSearch',
    'dispatchPreciseSearch',
  ];

  declare protected config: LayoutAgentExtendedConfig;

  /** 视觉模型 provider，用于 dispatchLayoutOcr 二次 OCR */
  private visionLlm: LlmProvider<MultimodalChatMessage>;

  /** 形状代码对照表（来自 exposed_types），注入 prompt 供 LLM 参考 */
  private shapeTypeTable: string;

  /** 颜色代码对照表（来自 exposed_colors），注入 prompt 供 LLM 参考 */
  private colorTable: string;

  constructor(
    textLlm: LlmProvider<ChatMessage>,
    visionLlm: LlmProvider<MultimodalChatMessage>,
    config: LayoutAgentExtendedConfig,
  ) {
    super(textLlm, config);
    this.visionLlm = visionLlm;
    this.shapeTypeTable = getShapeTypeTable();
    this.colorTable = getColorTable();
  }

  getSystemPrompt(): string {
    return '';
  }

  getTools(): ToolDefinition[] {
    return [
      ...LAYOUT_TOOLS,
      SEARCH_SKU_SHAPE_TOOL,
      SEARCH_SKU_DESCRIPTION_TOOL,
      DISPATCH_LAYOUT_OCR_TOOL,
      DISPATCH_BATCH_SEARCH_TOOL,
      DISPATCH_PRECISE_SEARCH_TOOL,
    ];
  }

  getBudgetedToolNames(): Set<ToolName> {
    // 搜索工具 + dispatch 工具均计入预算，预算本质是限制总耗时
    return new Set([
      'searchSkuShape',
      'searchSkuDescription',
      'dispatchLayoutOcr',
      'dispatchBatchSearch',
      'dispatchPreciseSearch',
    ]);
  }

  /**
   * 将委派子 agent 的 dispatch 工具标记为可并发执行。
   * layout 修改工具不并发，避免共享 layout 状态竞态。
   */
  protected override canExecuteInParallel(toolName: ToolName): boolean {
    return [
      'dispatchLayoutOcr',
      'dispatchBatchSearch',
      'dispatchPreciseSearch',
    ].includes(toolName);
  }

  // ================================================================
  //  工具执行分发
  // ================================================================

  protected async executeTool(
    tc: ToolCall,
    context: AgentContext,
  ): Promise<string> {
    const ctx = context as LayoutAgentContext;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      console.warn(`[LayoutAgent] ${tc.function.name} 参数解析出错`);
    }

    switch (tc.function.name) {
      // ---- 搜索工具（补漏） ----
      case 'searchSkuShape':
        return executeSearchSkuShape(args);
      case 'searchSkuDescription':
        return executeSearchSkuDescription(args);

      // ---- dispatch 工具 ----
      case 'dispatchBatchSearch': {
        const batch = Array.isArray(args.batch) ? args.batch : [];
        if (batch.length === 0) return 'dispatchBatchSearch: batch 为空或格式错误';
        const sub = new BatchSearchAgent(this.llm, {
          budgetLimit: 5,
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
          budgetLimit: 5,
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

      case 'dispatchLayoutOcr': {
        const note = String(args.note ?? '').trim();
        if (!note) return 'dispatchLayoutOcr: note 必填';
        const ocrInput: LayoutOcrInput = {
          image: ctx.image,
          viewType: ctx.viewType,
          associatedWallNames: ctx.associatedWallNames,
          note,
        };
        const sub = new LayoutOcrAgent(this.visionLlm, {
          budgetLimit: 0,
          maxRounds: 2,
          langHint: this.config.langHint,
          onStep: (evt) => {
            if (evt.type === 'tool_call') {
              this.config.onStep?.({ type: 'tool_call', tool: `ocr>${evt.tool}` });
            }
          },
        });
        if (this.trace) {
          // OCR 子 trace 需要 override 为 OpenRouter 的 provider/model
          sub.trace = this.initSubTrace(this.trace, 'LayoutOcrAgent', tc.id, {
            provider: this.visionLlm.providerName,
            model: this.visionLlm.model,
          });
        }
        return sub.runOcr(ocrInput);
      }

      // ---- 布局工具 ----
      default: {
        const result = await executeLayoutTool(ctx.mutableLayout, tc.function.name, args);

        // 修改了布局 → 推送 layout_update 快照
        if (LAYOUT_MUTATING_TOOLS.has(tc.function.name)) {
          this.config.onLayoutUpdated?.({
            layout: ctx.mutableLayout.layout,
            tool: tc.function.name,
            message: result,
          });
        }

        return result;
      }
    }
  }

  // ================================================================
  //  Public API
  // ================================================================

  /**
   * 接收 OCR 预处理文本 + 当前布局，编排布局识别和修改流程。
   * 不再直接接收图片——图片 OCR 由路由层调用 LayoutOcrAgent 完成。
   */
  async parse(args: {
    initialOcrText: string;
    viewType?: string;
    associatedWallIds?: string[];
    layout: LayoutDocument;
    /** 原始图片 data URL（供 dispatchLayoutOcr 二次 OCR 使用） */
    image: string;
  }): Promise<{ layout: LayoutDocument; reply: string }> {
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

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: this.buildPrompt(viewType, associatedNames),
      },
      {
        role: 'user',
        content:
          `请根据以下 OCR 识别结果，更新当前布局中**此图所关联的墙**上的物品，使关联墙的布局与图片一致。其他与此图无关的墙仅供参考，**保持原样，不要删改**。\n\n## 初始 OCR 结果\n\n${args.initialOcrText}`,
      },
    ];

    const context: LayoutAgentContext = {
      mutableLayout,
      viewType,
      associatedWallNames: associatedNames,
      image: args.image,
    };

    const result = await this.run(messages, context);

    if (config.chatLog) {
      writeChatLog(result.messages);
    }

    return { layout: mutableLayout.layout, reply: result.reply };
  }

  // ================================================================
  //  Private helpers
  // ================================================================

  private buildPrompt(viewType: string, associatedNames: string[]): string {
    const wallHint = associatedNames.length > 0
      ? `此图**仅**描述以下 ${associatedNames.length} 面墙: ${associatedNames.join(', ')}。`
      : '此图片不与已有的布局相关联，请新建墙以容纳此图片描述的布局。';
    const shapeTable = this.shapeTypeTable || '（暂无数据）';
    const colorTable = this.colorTable || '（暂无数据）';

    return `你是一个厨房橱柜布局编排助手。系统已经通过 OCR 预处理识别了图片中的橱柜结构，
你的任务是根据 OCR 结果和当前布局，调用工具进行编排修改。
${wallHint}布局中**其他墙与此图无关**，不得修改或删除。

## 形状代码对照表

| 代码 | 描述 |
|------|------|
${shapeTable}

## 颜色代码对照表

| 代码 | 名称 |
|------|------|
${colorTable}

## 布局数据模型

一个布局包含若干墙（wall）。每面墙有两个轨道：
- **airBlocks**（空中轨道）：吊柜(wall_cabinet)、高柜(tall_cabinet)、空挡(gap)、塞了东西的空挡(stuffed_gap)、遮挡性不强的商品(gaplike_item)、填充条(filler)、高电器(tall_appliance)及其叠放吊柜
- **groundBlocks**（地面轨道）：地柜(base_cabinet)、高柜(tall_cabinet)、空挡(gap)、塞了东西的空挡(stuffed_gap)、遮挡性不强的商品(gaplike_item)、填充条(filler)、高电器(tall_appliance)、需台面电器(base_appliance_need_top)、免台面电器(base_appliance_without_top)

全高物品（tall_cabinet/tall_appliance）同时在 air 和 ground 两轨各有一个 block，共享同一个 item ID。
墙吊柜（wall_cabinet）和全高物品的 air 块支持多个物品堆叠（stackedItems，每个包含 sku 和可选 height）。

每个 block 可以设置 colorCode（颜色代码，如 "02"），通过 insertItem 的 colorCode 参数设置。
base_cabinet 物品可以标记为 vanity cabinet（isVanity: true），仅在 ground 轨有效，通过 insertItem 的 isVanity 参数设置。

## 高度规则

- air 轨物品（wall_cabinet、tall_cabinet、tall_appliance）及叠放吊柜尽量填写自身的高度（英寸）。对于 wall_cabinet 与叠放吊柜，不要填成从地面到其顶部的高度。
- 地面柜（base_cabinet、base_appliance_*）因高度统一，无需填写 height。
- 全高物品（tall_cabinet / tall_appliance）写入 height 后，通过共享的 item ID 同步到两轨；从 ground 轨点击编辑高度时也会自动同步 air 轨。
- 叠放吊柜各自记录自己的 height，互不影响。主物品高度和叠放吊柜高度各自独立。
- 使用 insertItem / insertItemAtPosition 时，stackedItems 为对象数组 [{ "sku": "...", "height": ... }]，单次请求内构造即可。

岛台是一种特殊的墙。通过 backToBackIslandIds 表示背靠背关系。
connectedWallIds 表示 L 形转角连接关系。connectIslands 用于设置背靠背关系，connectWalls 用于设置转角连接。

## 物品分类说明

| 分类 | 含义 | 轨道 |
|------|------|------|
| wall_cabinet | 吊柜 | air |
| base_cabinet | 地柜 | ground |
| tall_cabinet | 高柜 | air + ground |
| gap | 空挡 | air 或 ground |
| stuffed_gap | 塞了东西的空挡（抽油烟机/窗户等，本质同 gap） | air 或 ground |
| gaplike_item | 遮挡性不强的商品（VAL/Glass Holder/WES等），进清单但两侧不遮挡 | air 或 ground |
| filler | 填充条/窄条（窄填板等），进清单 | air 或 ground 或 air + ground |
| tall_appliance | 高电器（冰箱等） | air + ground |
| base_appliance_need_top | 需台面电器（洗碗机等） | ground |
| base_appliance_without_top | 免台面电器（灶台等） | ground |

## 颜色规则

- 以下分类**不需要颜色**，colorCode 留空即可，不要强行添加颜色代码：gap、stuffed_gap、tall_appliance、base_appliance_need_top、base_appliance_without_top
- 以下分类**需要颜色**（如果 OCR/图片中有标注）：wall_cabinet、base_cabinet、tall_cabinet、filler、gaplike_item
- 如果没有提供颜色标注信息，colorCode 留空，SKU 也只填型号（如 "B15" 而非 "02B15"），不要猜测颜色

## 工具集

### 布局工具
- **readLayout**：读取当前布局的完整信息
- **createWall / deleteWall**：创建/删除墙或岛台
- **insertItem**：在墙的最左侧插入物品（自动排到最左侧）
- **deleteItem**：删除物品，mode="static" 留空挡，"dynamic" 右侧左移
- **insertItemAtPosition**：在指定距左距离处精确插入物品
- **updateWallProperties**：修改墙的宽度、暴露面属性（OCR 识别出的总宽优先填入此方法）
- **connectWalls / disconnectWalls**：管理 L 形转角连接
- **connectIslands / disconnectIslands**：管理岛台背靠背关系

### 搜索工具
- **searchSkuShape**：编辑距离模糊匹配形状代码 + 颜色
- **searchSkuDescription**：BM25 全文检索描述字段 + 颜色

### 委派工具
- **dispatchBatchSearch**：批量委派给 BatchSearchAgent 搜索验证 SKU
- **dispatchPreciseSearch**：单条深度精确搜索
- **dispatchLayoutOcr**：要求 OCR agent 重新检查原图特定区域（传入 note 说明需要复查什么）

## 工作流程

1. **阅读 OCR 结果**：仔细阅读用户消息中的初始 OCR 结果，其中可能有一个或多个双轨列表，每个列表标题可能包含总宽信息
2. **调用 readLayout**：读取当前布局状态
3. **将 OCR 列表与关联墙/岛台匹配**：判断每个 block 的轨道、宽度、双轨属性、分类、墙总宽度。OCR 列表标题中的总宽信息优先用于 updateWallProperties
4. **验证 SKU**：对需要数据库验证的柜体型号或商品型号，调用 dispatchBatchSearch 或 dispatchPreciseSearch，或亲自用 searchSkuShape/searchSkuDescription 补漏，仍无法确定的优先保留 OCR 列表中的原始信息
5. **二次 OCR（如需要）**：如果发现 OCR 可能识别时有遗漏、双轨无法对齐、宽度总和明显冲突，调用 dispatchLayoutOcr 并带上具体备注
6. **修改布局**：使用 layout tools 增量修改布局
7. **中文总结**：最后用中文简短说明修改了什么，以及哪些区域仍不确定

## 重要规则

- **所有物品必须指定 SKU**。尽量填 DUKO 产品代码（如 "02B15"），无法确定 DUKO 产品代码时使用原始信息中的产品代码，无法确定 SKU 的填具体名称（如 "refrigerator"、"range hood"），空挡填 "gap"
- **宽度单位为英寸**
- **位置由系统自动管理**：使用 insertItem 时物品自动排到最左侧。仅在需要精确定位时使用 insertItemAtPosition
- **仅对关联墙上的物品进行修改**：未关联的墙上的物品保持不变
- 对于关联墙上的已有物品：**优先保留**，仅当你能 100% 确定与 OCR/图片矛盾时才删除
- **同一布局可能由多张不同视角/区域的图片逐步完善**，本次请求仅处理当前 OCR 呈现的信息
- dispatch 类工具（dispatchLayoutOcr / dispatchBatchSearch / dispatchPreciseSearch）可以并发调用
- layout 修改工具会串行执行，每次修改后无需再次 readLayout
- **严禁删除、修改或重命名未关联的墙**：只能修改关联墙上的物品。非关联墙即使看起来与 OCR/图片不完全匹配，也必须原封不动地保留，因为它们由其他图片负责
- **仅使用中文回复**，简洁告知用户做了哪些修改`;
  }
}

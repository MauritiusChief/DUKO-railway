/**
 * LayoutOcrAgent —— 厨房布局图片 OCR 预处理 Agent
 *
 * 接收 base64 图片，调用 OpenRouter 多模态视觉模型识别图片中的橱柜结构，
 * 输出一个或多个双轨列表（每面墙/岛台一个列表），供后续 LayoutAgent 使用。
 *
 * 职责边界：
 *  - 只做图像文本/宽度/双轨属性识别，不做型号解释或 SKU 查询
 *  - 不访问当前 layout（通过 dispatchLayoutOcr 的 note 获取额外信息）
 *  - 不检查双轨物体是否真实对齐
 *  - 不查询产品数据库；但会注入 exposed_types 形状代码分类对照表辅助分类
 *  - 不开放任何工具（0 tools），直接返回 OCR 文本
 */

import { BaseAgent, type AgentContext, type BaseAgentConfig } from './base.js';
import type { ToolCall } from '../types/tool.js';
import type { MultimodalChatMessage } from '../types/message.js';
import type { LlmProvider } from '../llm/provider.js';
import { config } from '../config/env.js';
import { writeChatLog } from '../services/logger.js';
import { buildLayoutCategoryShapeTable } from '../services/utils.js';

// ==================================================================
//  LayoutOcrAgent 输入
// ==================================================================

export interface LayoutOcrInput {
  /** base64 data URL 格式图片 */
  image: string;
  /** 视图类型：top / elevation / 3d */
  viewType?: string;
  /** 关联的墙名列表（用于提示 LLM 这张图对应哪些墙） */
  associatedWallNames?: string[];
  /** 复查备注（由 dispatchLayoutOcr 传来，用于二次 OCR） */
  note?: string;
}

// ==================================================================
//  LayoutOcrAgent
// ==================================================================

export class LayoutOcrAgent extends BaseAgent<MultimodalChatMessage> {
  /** 不开放任何工具 */
  static override ownedToolNames: string[] = [];

  /** 已分类 shapeType 的三列对照表（code/描述/分类），注入 prompt 辅助分类 */
  private layoutCategoryTable: string;

  constructor(llm: LlmProvider<MultimodalChatMessage>, agentConfig?: BaseAgentConfig) {
    super(llm, agentConfig ?? {
      budgetLimit: 0,
      maxRounds: 2,
      langHint: '中文',
    });
    this.layoutCategoryTable = buildLayoutCategoryShapeTable();
  }

  getSystemPrompt(): string {
    return '';
  }

  getTools(): [] {
    return [];
  }

  protected async executeTool(
    _tc: ToolCall,
    _context: AgentContext,
  ): Promise<string> {
    // LayoutOcrAgent 不开放任何工具，此方法不应被调用
    return 'LayoutOcrAgent 未注册任何工具';
  }

  // ================================================================
  //  Public API
  // ================================================================

  /**
   * 对图片进行 OCR，返回双轨列表文本。
   * 由于没有任何工具，LLM 仅返回自然语言回复。
   */
  async runOcr(input: LayoutOcrInput): Promise<string> {
    const viewType = input.viewType || 'top';
    const note = input.note;

    const wallHint = input.associatedWallNames && input.associatedWallNames.length > 0
      ? `此图描述以下墙: ${input.associatedWallNames.join(', ')}。`
      : '';

    const noteText = note
      ? `\n\n## 复查备注\n\n${note}`
      : '';

    const messages: MultimodalChatMessage[] = [
      {
        role: 'system',
        content: this.buildOcrPrompt(viewType, wallHint),
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `请识别这张图片中的橱柜布局，将每个物品标注名称、宽度和所在轨道。${noteText}`,
          },
          { type: 'image_url', image_url: { url: input.image, detail: 'high' } },
        ],
      },
    ];

    const result = await this.run(messages, {});

    if (config.chatLog) {
      writeChatLog(result.messages);
    }

    return result.reply || '';
  }

  // ================================================================
  //  Private helpers
  // ================================================================

  private buildOcrPrompt(viewType: string, wallHint: string): string {
    return `你是一个厨房橱柜布局 OCR 识别助手。你正在分析一张 ${viewType} 视图的图片。
${wallHint}

## 任务

请仔细阅读图片，将每个布局的橱柜和电器逐项列出，并且辨认或者推断此布局的左侧、右侧与后侧是否有墙或者其他遮挡。**你的唯一任务是识别图片中可见的物品及其属性——不要做任何型号解释或布局对齐检查。**

## 总体宽度

**重要**：请从图片中识别每面墙/岛台/连续段的总体宽度标记（如尺寸标注、总长数字），并在 OCR 列表标题中注明，格式如下：
\`## OCR List 1 (总宽约 XX in)\`

如果图片中没有明确的总体宽度标注，请根据画面比例估算并标注 \`(est.)\`。

## 暴露情况

请从图片中识别每面墙的左右两侧是否有其他墙遮挡（后侧默认有遮挡，因为这面墙本身就是遮挡），或者岛台左右两侧接墙形成半岛，或者岛台是否有两排橱柜背靠背放置而互相遮挡后侧。

有时左右两侧的墙不会直接画出，需要通过布局推断。如果侧边存在宽度不超过1.5英寸的条状物，那么很可能就是专门用来覆盖暴露的侧面的装饰板。因此，便可以确认这个侧边肯定暴露。此条状物本身不用加入物品分类，标记此侧暴露即可。

## 形状代码分类对照

下表列出会作为布局块出现的 DUKO 产形状代码及其分类。识别到这些代码时按此表归类；不在表中的代码多为配件（不作布局块）或按名称判定的电器。

| shapeTypeCode | 描述 | 分类 |
|------|------|------|
${this.layoutCategoryTable || '（暂无数据）'}

## 物品分类

| 分类 | 含义 | 轨道 |
|------|------|------|
| wall_cabinet | 吊柜 | air |
| base_cabinet | 地柜 | ground |
| tall_cabinet | 通天高柜 | air + ground |
| gap | 空挡 | air 或 ground |
| stuffed_gap | 塞了东西的空挡（抽油烟机/窗户等），本质同 gap | air 或 ground |
| gaplike_item | 开放性商品，进清单但两侧遮挡不住 | air 或 ground |
| filler | 填充条/窄条，进清单 | air 或 ground 或 air + ground |
| tall_appliance | 高电器（冰箱等） | air + ground |
| base_appliance_need_top | 需台面电器（洗碗机等） | ground |
| base_appliance_without_top | 免台面电器（灶台等） | ground |

**注意**：
- **stuffed_gap** 仅用于该位置上**没有任何需要进清单物体**的纯空位（如纯窗户、纯抽油烟机位），不进清单、仅触发邻接外露
- **gaplike_item** 用于 DUKO 产的开放性商品（具体哪些 shapeTypeCode 见上方"形状代码分类对照"），进清单但不像柜体那样能遮挡两侧。一旦是 DUKO 产开放性商品，必须标为 gaplike_item 而非 stuffed_gap

## 输出格式

对图片中的每面墙（或独立连续段）输出一个 OCR 列表，格式如下：

\`\`\`md
## OCR List 1 (总宽约 XX", 左侧暴露)

* air
  * {物品名称或分类标签} - {宽度}"  [also in ground]
  * {物品名称或分类标签} - {宽度}"
* ground
  * {物品名称或分类标签} - {宽度}"  [also in air]

## OCR List 2 (总宽约 XX", 右侧暴露)
...
\`\`\`

**标记说明**：
- 物品名直接使用图片中看到的标注文字（如 "W3024"、"REF"），仅在无标注文字且通过画面可识别类型的时候使用分类标签，除了 gap
- 可见的 gap 用 \`(gap)\` 标记
- 若物品在 air 和 ground 两轨都存在（tall_cabinet / tall_appliance），在对应条目后标注 \`[also in ground]\` 或 \`[also in air]\`
- 宽度单位为英寸，根据图片中的标注数字提取；若无明确标注则根据比例估算并标注 \`(est.)\`

## 重要规则

- **仅输出图片中能看到的信息**，不要推测看不见的区域
- 如果图片中的文字不清晰，标注 \`(?)\` 表示不确定
- 如果一面墙上多个柜子看起来尺寸相同但标注模糊，请标注你的最佳猜测并附加 \`(?)\`
- 用中文输出简短说明后，输出 OCR 列表`;
  }
}

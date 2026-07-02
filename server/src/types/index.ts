/**
 * 类型统一导出入口
 *
 * 后续各模块通过 `import { ... } from '../types/index.js'` 获取所有公共类型。
 */

export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolExecutor,
  ToolRegistry,
} from './tool.js';

export type {
  ChatMessage,
  MultimodalContent,
  MultimodalChatMessage,
  LlmMessage,
} from './message.js';

export type {
  AgentRole,
  AgentMessage,
} from './agent.js';

export type {
  ParsedField,
  ParsedItem,
  ProductEntry,
  MutableManifest,
  NoteAccumulator,
  ChatNote,
  ChatHistoryEntry,
} from './manifest.js';

export type {
  TrackSpan,
  BlockItemCategory,
  BlockItem,
  SectionBlock,
  LayoutWall,
  LayoutDocument,
  PositionedBlock,
  LayoutInstruction,
  MutableLayout,
} from './layout.js';

export type {
  SkuRecord,
  SkuSearchResult,
} from './sku.js';

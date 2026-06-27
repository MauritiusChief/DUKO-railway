/**
 * LLM 模块统一入口
 *
 * 导出内容：
 *  - 接口与类型：LlmProvider, LlmProviderConfig, ResponseFormat
 *  - 工厂函数：createDeepSeekProvider, createOpenRouterProvider
 *  - 默认配置常量：DEEPSEEK_DEFAULTS, OPENROUTER_DEFAULTS
 *
 * 后续 Agent 层和路由层通过此模块创建 LLM 实例，无需直接依赖 services/ 下的具体实现。
 *
 * @example
 *   import { createDeepSeekProvider } from '../llm/index.js';
 *
 *   const chatLlm = createDeepSeekProvider({
 *     apiKey: config.deepseekApiKey,
 *     model: 'deepseek-v4-flash',
 *   });
 *
 *   const visionLlm = createOpenRouterProvider({
 *     apiKey: config.openrouterApiKey,
 *     model: 'qwen/qwen3.7-plus',
 *   });
 */

export {
  createDeepSeekProvider,
  createOpenRouterProvider,
  DEEPSEEK_DEFAULTS,
  OPENROUTER_DEFAULTS,
} from './provider.js';

export type {
  LlmProviderConfig,
  LlmProvider,
  ResponseFormat,
  StreamChunk,
} from './provider.js';

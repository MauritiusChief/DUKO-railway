/**
 * Transformers.js 本地 Embedding 服务
 *
 * 使用 onnx-community/all-MiniLM-L6-v2-ONNX 模型在本地生成文本向量（384 维），
 * 无需调用外部 API，适合内网离线环境。
 *
 * 首次运行会自动从 HuggingFace 下载模型文件（~23MB），缓存在本地。
 * 模型加载后常驻内存，通过单例模式避免重复初始化。
 */

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

// 单例：pipeline 对象全局复用，避免每次调用都重新加载模型
let pipe: FeatureExtractionPipeline | null = null;

/**
 * 懒加载 pipeline 单例。
 * 首次调用时下载/加载模型（可能耗时数秒），后续直接返回缓存实例。
 */
async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipe) {
    // feature-extraction 管道：输入文本 → 输出高维向量
    pipe = await pipeline('feature-extraction', 'onnx-community/all-MiniLM-L6-v2-ONNX');
  }
  return pipe;
}

/**
 * 批量文本转向量。
 * 循环逐条处理（当前版本 Transformers.js 的 feature-extraction
 * 对数组输入支持不稳定，逐条处理更可靠）。
 *
 * @param texts - 待嵌入的文本列表
 * @returns 每个文本对应的 384 维浮点向量数组
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const p = await getPipeline();
  const results: number[][] = [];

  for (const text of texts) {
    // pooling: 'mean' → 对 token 级别的向量取均值，得到句子级嵌入
    // normalize: true  → L2 归一化，保证向量模长为 1，便于余弦相似度计算
    const output = await p(text, { pooling: 'mean', normalize: true });

    // output.data 是 Float32Array，转为普通数组便于序列化/存储
    results.push(Array.from(output.data as Float32Array));
  }

  return results;
}

/**
 * 单条文本转向量（便捷封装）。
 *
 * @param text - 待嵌入的文本
 * @returns 384 维浮点向量
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const embeddings = await getEmbeddings([text]);
  return embeddings[0];
}

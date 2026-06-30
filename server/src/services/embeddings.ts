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

const EMBED_DIM = 384;
const BATCH_SIZE = 64;

// 单例：pipeline 对象全局复用，避免每次调用都重新加载模型
let pipe: FeatureExtractionPipeline | null = null;

/**
 * 懒加载 pipeline 单例。
 * 首次调用时下载/加载模型（可能耗时数秒），后续直接返回缓存实例。
 */
async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipe) {
    pipe = await pipeline('feature-extraction', 'onnx-community/all-MiniLM-L6-v2-ONNX');
  }
  return pipe;
}

/**
 * 批量文本转向量。
 *
 * 使用 FeatureExtractionPipeline 的数组输入能力进行真批量推理：
 * tokenizer 自动 padding 后，ONNX 模型一次性处理整个 batch，
 * 相比逐条调用提升 10-50x（取决于 batch 大小和 CPU 核心数）。
 *
 * @param texts - 待嵌入的文本列表
 * @returns 每个文本对应的 384 维浮点向量数组
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const p = await getPipeline();
  const results: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const batch = texts.slice(offset, offset + BATCH_SIZE);

    // 一次性传入整个 batch，pipeline 内部 tokenizer 自动 padding 对齐
    const output = await p(batch, { pooling: 'mean', normalize: true });

    // output.dims = [batchSize, embedDim]
    // output.data 是一个扁平 Float32Array，长度为 batchSize * embedDim
    const flat = output.data as Float32Array;
    for (let i = 0; i < batch.length; i++) {
      const start = i * EMBED_DIM;
      results.push(Array.from(flat.subarray(start, start + EMBED_DIM)));
    }
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

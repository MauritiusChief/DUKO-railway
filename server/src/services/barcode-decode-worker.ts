/**
 * 条码解码 worker（仓库扫码服务端解码）
 *
 * 在独立线程中从本地依赖包加载 zxing-wasm/reader 的 WASM 二进制并解码 RGBA 像素。
 * 不访问网络、数据库、环境变量或外部模型；不产生日志，失败仅以固定字符串回传，
 * 原始像素与条码值不落盘、不打印。
 *
 * 消息协议：
 *   收到 { id, rgba: ArrayBuffer, width, height }（rgba 为 RGBA 原始像素，transfer 到达）
 *   回传 { id, ok: true, values: string[] } 或 { id, ok: false, error: 'decode-failed' }
 */

import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const require = createRequire(import.meta.url);

// WASM 二进制必须与本包锁定的 zxing-wasm 版本一致；从依赖包内读取，不经网络。
// Buffer 底层 ArrayBuffer 可能带偏移，切片出精确副本再交给 Emscripten。
const wasmFile = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
const wasmBinary = wasmFile.buffer.slice(
  wasmFile.byteOffset,
  wasmFile.byteOffset + wasmFile.byteLength,
) as ArrayBuffer;

prepareZXingModule({
  overrides: { wasmBinary },
  fireImmediately: true,
}).catch(() => {
  // 初始化失败时让 worker 退出，由主线程按异常退出路径重建/熔断
  process.exitCode = 1;
});

interface DecodeRequest {
  id: number;
  rgba: ArrayBuffer;
  width: number;
  height: number;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  values?: string[];
  error?: string;
}

parentPort!.on('message', async (msg: DecodeRequest) => {
  const port = parentPort!;
  try {
    // zxing-wasm 的 ImageData 为 duck-typed（data/width/height），无需 DOM 环境
    const imageData = {
      data: new Uint8ClampedArray(msg.rgba),
      width: msg.width,
      height: msg.height,
    } as unknown as ImageData;

    const results = await readBarcodes(imageData, { tryHarder: true });
    const reply: WorkerReply = { id: msg.id, ok: true, values: results.map((r) => r.text) };
    port.postMessage(reply);
  } catch {
    const reply: WorkerReply = { id: msg.id, ok: false, error: 'decode-failed' };
    port.postMessage(reply);
  }
});

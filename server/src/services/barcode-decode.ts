/**
 * 仓库扫码条码解码服务
 *
 * 输入一张上传图片（JPEG/PNG/HEIC）的 Buffer，流程：
 *   魔数与 MIME 一致性检验 → sharp 读取元数据并限制像素 → 自动方向 + RGBA 原始像素 →
 *   交给解码 worker 池（2 个 worker，等待队列 4，单任务硬超时 8s）→
 *   以与既有仓库业务一致的规则规范化并分类全部解码结果。
 *
 * 资源边界：文件大小由路由层 multer 限制；此处限制像素数、解码超时、并发与队列长度。
 * 分类语义（与前端扫码规则一致）：至多一个型号格式值和一个产品格式值为合法结果；
 * 无条码、格式外条码、同类型重复或任何额外条码返回不含候选值的结果类别。
 * 图片数据与解码值不写入日志、trace 或磁盘；错误仅携带固定类别/固定文案。
 *
 * 该服务绝不调用任何数据层写入函数。
 */

import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import {
  MODEL_SERI_NUM_RE,
  PRODUCT_SERI_NUM_RE,
  normalizeSerial,
} from '../validation/warehouse.js';

// ---- 资源保护参数 ----

/** 输入像素上限（约 24MP，如 6000×4000） */
const MAX_PIXELS = 24_000_000;
/** 单任务硬超时（覆盖像素转换 + WASM 解码）；超时 worker 被终止并重建 */
const DECODE_TIMEOUT_MS = 8_000;
/** 解码 worker 数量（约每秒两张现场吞吐的解码容量） */
const WORKER_COUNT = 2;
/** 等待队列深度；队列满或排队超时按服务繁忙拒绝 */
const MAX_QUEUE = 4;
/** 任务在队列中的最长等待时间；超时按 503 拒绝 */
const QUEUE_TIMEOUT_MS = 15_000;
/** worker 连续异常重建次数上限；达到后熔断该槽位，防止无限重建 */
const MAX_CONSECUTIVE_SPAWN_FAILURES = 5;

// ---- 错误类型（路由层据此映射 HTTP 状态） ----

/** 输入图片非法（魔数无效、MIME 不符、像素超限等），status 为映射的 HTTP 状态码 */
export class BarcodeImageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BarcodeImageError';
  }
}

/** 解码容量饱和（队列满或排队超时）→ 503 */
export class BarcodeDecodeBusyError extends Error {
  constructor() {
    super('解码繁忙，请稍后重试');
    this.name = 'BarcodeDecodeBusyError';
  }
}

// 内部错误：不外抛，最终转为业务结果 decode-failed
class ImageProcessError extends Error {}
class WorkerDecodeError extends Error {}

// ---- 业务结果 ----

export type BarcodeDecodeResult =
  | { ok: true; model?: string; product?: string }
  | { ok: false; reason: 'no-barcode' | 'invalid' | 'decode-failed' };

/** 图片魔数类别 */
type ImageKind = 'jpeg' | 'png' | 'heic';

// ---- MIME 与魔数检验 ----

/** 路由层 fileFilter 允许的声明 MIME（大小写不敏感） */
const ALLOWED_MIME_RE = /^image\/(jpeg|png|heic|heif|heic-sequence|heif-sequence)$/i;

/** 判断声明的 MIME 是否被接受（仅作快速预滤；真实格式以魔数为准） */
export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME_RE.test(mime);
}

/** MIME 基础类型与魔数类别的对应关系 */
const MIME_KIND_RE: { kind: ImageKind; re: RegExp }[] = [
  { kind: 'jpeg', re: /^image\/jpeg$/i },
  { kind: 'png', re: /^image\/png$/i },
  { kind: 'heic', re: /^image\/hei[cf](-sequence)?$/i },
];

/** HEIF 家族 brand（ftyp 后 4 字节，小写比较） */
const HEIC_BRAND_RE = /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)/;

/** 通过魔数识别图片类别；无法识别时返回 null */
function detectImageKind(buffer: Buffer): ImageKind | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1').toLowerCase();
    return HEIC_BRAND_RE.test(brand) ? 'heic' : null;
  }
  return null;
}

// ---- 结果分类（与扫码页规则一致） ----

/** 规范化并分类全部解码值：至多一个型号 + 一个产品为合法；其余归入固定结果类别 */
function classify(rawValues: string[]): BarcodeDecodeResult {
  const codes = rawValues.map((v) => normalizeSerial(String(v))).filter(Boolean);
  if (codes.length === 0) return { ok: false, reason: 'no-barcode' };

  const models = codes.filter((c) => MODEL_SERI_NUM_RE.test(c));
  const products = codes.filter((c) => PRODUCT_SERI_NUM_RE.test(c));
  if (
    models.length + products.length !== codes.length ||
    models.length > 1 ||
    products.length > 1
  ) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, model: models[0], product: products[0] };
}

// ---- worker 池 ----

interface DecodeTask {
  id: number;
  buffer: Buffer;
  settle: (err: Error | null, values?: string[]) => void;
  settled: boolean;
  queueTimer: NodeJS.Timeout | null;
  decodeTimer: NodeJS.Timeout | null;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  values?: string[];
}

interface WorkerSlot {
  index: number;
  worker: Worker | null;
  busy: boolean;
  task: DecodeTask | null;
  /** 已被超时/异常路径接管，旧对象上的事件不再处理 */
  replaced: boolean;
  /** 永久熔断（连续重建失败过多），不再接收任务 */
  dead: boolean;
}

/** 编译产物与 tsx 直跑 TS 两种形态下都能定位 worker 入口 */
function workerUrl(): URL {
  const isTs = import.meta.url.endsWith('.ts');
  return new URL(isTs ? './barcode-decode-worker.ts' : './barcode-decode-worker.js', import.meta.url);
}

const slots: WorkerSlot[] = [];
const queue: DecodeTask[] = [];
const consecutiveFailures: number[] = new Array(WORKER_COUNT).fill(0);
let nextTaskId = 1;

function createSlot(index: number): WorkerSlot {
  const slot: WorkerSlot = {
    index,
    worker: null,
    busy: false,
    task: null,
    replaced: false,
    dead: false,
  };
  try {
    // worker 文件的模块形态由最近 package.json 的 type:module（编译产物）
    // 或 tsx 加载器（开发直跑 TS）决定，无需显式选项
    const worker = new Worker(workerUrl());
    worker.unref(); // 不阻止进程退出
    slot.worker = worker;

    worker.on('message', (msg: WorkerReply) => {
      const task = slot.task;
      if (!task || task.settled) return;
      if (task.decodeTimer) {
        clearTimeout(task.decodeTimer);
        task.decodeTimer = null;
      }
      consecutiveFailures[slot.index] = 0;
      task.settle(msg && msg.ok ? null : new WorkerDecodeError(), msg?.values ?? []);
      releaseSlot(slot);
    });

    worker.on('error', () => handleSlotLoss(slot));
    worker.on('exit', () => handleSlotLoss(slot));
  } catch {
    handleSlotLoss(slot);
  }
  return slot;
}

/** worker 异常退出：终止路径（replaced=true）之外的情况在此重建或熔断 */
function handleSlotLoss(slot: WorkerSlot): void {
  if (slot.replaced) return;
  slot.replaced = true;
  const task = slot.task;
  if (task && !task.settled) {
    if (task.decodeTimer) clearTimeout(task.decodeTimer);
    task.settle(new WorkerDecodeError());
  }

  consecutiveFailures[slot.index] += 1;
  console.warn('[barcode-decode] 解码 worker 异常退出');
  if (consecutiveFailures[slot.index] > MAX_CONSECUTIVE_SPAWN_FAILURES) {
    console.error('[barcode-decode] worker 连续重建失败，已熔断该槽位');
    slots[slot.index] = {
      index: slot.index,
      worker: null,
      busy: false,
      task: null,
      replaced: false,
      dead: true,
    };
  } else {
    slots[slot.index] = createSlot(slot.index);
  }
  pump();
}

/** 任务完成/失败后释放槽位并调度后续任务 */
function releaseSlot(slot: WorkerSlot): void {
  slot.busy = false;
  slot.task = null;
  pump();
}

function clearTaskTimers(task: DecodeTask): void {
  if (task.queueTimer) {
    clearTimeout(task.queueTimer);
    task.queueTimer = null;
  }
  if (task.decodeTimer) {
    clearTimeout(task.decodeTimer);
    task.decodeTimer = null;
  }
}

/** 从队列取出任务并派发到空闲 worker */
function pump(): void {
  for (const slot of slots) {
    if (slot.busy || slot.dead || slot.replaced) continue;
    const task = queue.shift();
    if (!task) return;
    if (task.queueTimer) {
      clearTimeout(task.queueTimer);
      task.queueTimer = null;
    }
    slot.busy = true;
    slot.task = task;
    // 硬超时覆盖像素转换 + 解码全程
    task.decodeTimer = setTimeout(() => onTaskTimeout(slot), DECODE_TIMEOUT_MS);
    void runTask(slot, task);
  }
}

/**
 * 任务超时：终止当前 worker 并重建，任务按 decode-failed 处理。
 * 超时通常源于过大的图片而非 worker 故障，不计入熔断计数；
 * worker 崩溃/初始化失败走 handleSlotLoss 的熔断路径。
 */
function onTaskTimeout(slot: WorkerSlot): void {
  slot.replaced = true;
  slot.worker?.terminate();
  const task = slot.task;
  if (task && !task.settled) {
    task.settle(new WorkerDecodeError());
  }
  // 诊断：超时路径默认静默，此处仅计固定字符串
  console.warn('[barcode-decode] task timeout, worker restarted');
  slots[slot.index] = createSlot(slot.index);
  pump();
}

/** 像素转换与投递；超时/丢失后丢弃结果（任务已由对应路径处理） */
async function runTask(slot: WorkerSlot, task: DecodeTask): Promise<void> {
  try {
    const image = sharp(task.buffer, { limitInputPixels: MAX_PIXELS });
    const meta = await image.metadata();
    if (!meta.width || !meta.height) {
      throw new BarcodeImageError(415, '无法读取图片尺寸');
    }
    if (meta.width * meta.height > MAX_PIXELS) {
      throw new BarcodeImageError(413, '图片像素超出限制');
    }
    const { data, info } = await image.rotate().ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    if (slot.replaced || task.settled) return; // 已由超时/异常路径处理

    // sharp 输出的底层内存形态随环境不同（如 PM2 下不可 transfer，slice 副本仍继承
    // 其类型）；自行分配普通 ArrayBuffer 复制像素，保证可转移。原始像素随后清零。
    const rgba = new ArrayBuffer(data.byteLength);
    new Uint8Array(rgba).set(data);
    data.fill(0);

    slot.worker!.postMessage(
      { id: task.id, rgba, width: info.width, height: info.height },
      [rgba],
    );
  } catch (err) {
    if (!task.settled) {
      if (err instanceof BarcodeImageError) {
        task.settle(err);
      } else {
        // limitInputPixels 触发时 sharp 在读取元数据阶段即抛错，映射为像素超限
        const message = err instanceof Error ? err.message : '';
        if (/exceeds pixel limit/i.test(message)) {
          task.settle(new BarcodeImageError(413, '图片像素超出限制'));
        } else {
          // 诊断：catch 同时覆盖 sharp 与 postMessage；错误消息为库固定描述，不含图片内容
          console.error('[barcode-decode] pixel pipeline error:', message || String(err));
          task.settle(new ImageProcessError('图片处理失败'));
        }
      }
    }
    releaseSlot(slot);
  }
}

// ---- 对外入口 ----

/**
 * 解码一张图片并返回分类结果。
 *
 * reject 仅用于输入/容量类错误：
 *   - BarcodeImageError：魔数无效、MIME 不一致、像素超限（415/413）
 *   - BarcodeDecodeBusyError：队列饱和或排队超时（503）
 * 其余情况（图片损坏、worker 失败、超时）一律 resolve 为 decode-failed 结果类别。
 *
 * @param buffer 上传的图片原始字节（调用方负责处理完成后清零）
 * @param declaredMime 上传时声明的 MIME 类型，用于一致性检验
 */
export function decodeBarcodeImage(
  buffer: Buffer,
  declaredMime: string | undefined,
): Promise<BarcodeDecodeResult> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return Promise.reject(new BarcodeImageError(400, '缺少图片数据'));
  }
  if (declaredMime !== undefined && !isAllowedMime(declaredMime)) {
    return Promise.reject(new BarcodeImageError(415, '仅支持 JPEG / PNG / HEIC 图片'));
  }
  const kind = detectImageKind(buffer);
  if (!kind) {
    return Promise.reject(new BarcodeImageError(415, '不是有效的 JPEG / PNG / HEIC 图片'));
  }
  if (declaredMime !== undefined) {
    const matched = MIME_KIND_RE.some((m) => m.kind === kind && m.re.test(declaredMime));
    if (!matched) {
      return Promise.reject(new BarcodeImageError(400, '图片内容与声明的格式不符'));
    }
  }
  if (queue.length >= MAX_QUEUE) {
    return Promise.reject(new BarcodeDecodeBusyError());
  }

  return new Promise<BarcodeDecodeResult>((resolve, reject) => {
    const task: DecodeTask = {
      id: nextTaskId++,
      buffer,
      settled: false,
      queueTimer: null,
      decodeTimer: null,
      settle: (err, values) => {
        if (task.settled) return;
        task.settled = true;
        clearTaskTimers(task);
        if (err === null) {
          resolve(classify(values ?? []));
        } else if (
          err instanceof BarcodeImageError ||
          err instanceof BarcodeDecodeBusyError
        ) {
          reject(err);
        } else {
          // 图片损坏、worker 失败、解码超时：业务层可重试
          resolve({ ok: false, reason: 'decode-failed' });
        }
      },
    };

    task.queueTimer = setTimeout(() => {
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
      task.settle(new BarcodeDecodeBusyError());
    }, QUEUE_TIMEOUT_MS);

    queue.push(task);
    pump();
  });
}

// 初始化 worker 池
for (let i = 0; i < WORKER_COUNT; i += 1) {
  slots.push(createSlot(i));
}

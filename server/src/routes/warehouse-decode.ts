/**
 * 仓库扫码解码路由
 *
 * POST /api/warehouse/barcode-decode（挂载于 index.ts，先于通用 /api/warehouse）
 *   仅接受 multipart/form-data 的一个 photo 文件（内存存储，不落盘）；
 *   服务端解码成功返回至多一个型号与一个产品序列号，供前端合并本轮；
 *   该端点不写入任何数据层，用户确认后仍走既有 POST /api/warehouse/scans。
 *
 * 响应契约：
 *   200 { ok: true,  model?, product? }                —— 至少含一个序列号
 *   200 { ok: false, reason: 'no-barcode' | 'invalid' | 'decode-failed' }
 *   400/413/415 { error }                              —— 输入校验失败
 *   503 { error }                                      —— 解码容量饱和
 *
 * 安全边界：JWT + warehouse|manager|admin 角色；图片缓冲在响应前清零；
 * 错误日志与响应不包含图片名、图片内容或条码值。
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import { requireAnyRole } from '../middleware/auth.js';
import {
  decodeBarcodeImage,
  isAllowedMime,
  BarcodeImageError,
  BarcodeDecodeBusyError,
} from '../services/barcode-decode.js';

/** 上传文件大小上限（前端已压缩至受控 JPEG；此处为防滥用边界） */
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;

/** 内存存储：图片只存在于请求生命周期内，禁止写入磁盘 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: MAX_FILE_SIZE_BYTES,
    fields: 0, // 拒绝任何非文件字段
  },
  fileFilter: (_req, file, cb) => {
    if (isAllowedMime(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new BarcodeImageError(415, '仅支持 JPEG / PNG / HEIC 图片'));
    }
  },
});

export const warehouseDecodeRouter = Router();

/** multer 错误映射：不透出请求细节 */
function handleUploadError(err: unknown, res: Response): void {
  if (err instanceof BarcodeImageError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: '图片超过 8MB 大小限制' });
      return;
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({ error: '仅接受一个名为 photo 的图片文件' });
      return;
    }
    if (err.code === 'LIMIT_FIELD_COUNT') {
      res.status(400).json({ error: '不接受额外表单字段' });
      return;
    }
    res.status(400).json({ error: '上传内容不符合要求' });
    return;
  }
  res.status(500).json({ error: '解码失败' });
}

warehouseDecodeRouter.post(
  '/',
  requireAnyRole('warehouse', 'manager', 'admin'),
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('photo')(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      handleUploadError(err, res);
    });
  },
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      res.status(400).json({ error: '缺少 photo 图片文件' });
      return;
    }

    try {
      const result = await decodeBarcodeImage(file.buffer, file.mimetype);
      res.json(result);
    } catch (err) {
      if (err instanceof BarcodeImageError) {
        res.status(err.status).json({ error: err.message });
      } else if (err instanceof BarcodeDecodeBusyError) {
        res.status(503).json({ error: err.message });
      } else {
        res.status(500).json({ error: '解码失败' });
      }
    } finally {
      // 请求结束前将内存中的图片字节清零，尽快归还内存
      if (file && Buffer.isBuffer(file.buffer)) file.buffer.fill(0);
    }
  },
);

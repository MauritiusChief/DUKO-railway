/**
 * BarcodeDetector / BarcodeDetectorCompat 最小类型声明
 *
 * 该 API 为 Chromium 实验特性（Android Chrome 已支持），尚未进入 TS 标准 DOM lib。
 * 仅声明本仓库用到的成员；运行时仍需 feature detection（'BarcodeDetector' in window）。
 */

declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  /** 在图像（ImageBitmap 等）中检测条码，返回原始文本值列表 */
  detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]>;
  /** 返回当前浏览器支持的条码格式列表 */
  static getSupportedFormats(): Promise<string[]>;
}

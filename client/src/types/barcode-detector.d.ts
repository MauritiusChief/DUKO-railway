/**
 * 原生 BarcodeDetector 最小类型声明
 *
 * 该 API 尚未进入 TS 标准 DOM lib。运行时仍须 feature detection；不支持的浏览器
 * 使用 WarehouseScanPage 动态加载的 WASM ponyfill，而不是扩展全局对象。
 */

declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  /** 在图片或 Blob 中检测条码，返回原始文本值列表 */
  detect(source: ImageBitmapSource | Blob): Promise<{ rawValue: string }[]>;
  /** 返回当前浏览器支持的条码格式列表 */
  static getSupportedFormats(): Promise<string[]>;
}

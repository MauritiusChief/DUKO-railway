/**
 * ScriptCat 用户脚本国际化翻译字典
 *
 * 悬浮面板中所有 UI 文本，支持中文和英文。
 */
export type ScriptCatLang = 'zh' | 'en';

export interface ScriptCatTexts {
  panelTitle: Record<ScriptCatLang, string>;
  minimize: Record<ScriptCatLang, string>;
  close: Record<ScriptCatLang, string>;
  csvLabel: Record<ScriptCatLang, string>;
  writeBtn: Record<ScriptCatLang, string>;
  statusReady: Record<ScriptCatLang, string>;
  statusWriting: Record<ScriptCatLang, string>;
  statusDone: Record<ScriptCatLang, string>;
  statusPartial: Record<ScriptCatLang, string>;
  statusError: Record<ScriptCatLang, string>;
  statusErrMsg: Record<ScriptCatLang, string>;
  colModel: Record<ScriptCatLang, string>;
  colQty: Record<ScriptCatLang, string>;
  interceptAlert: Record<ScriptCatLang, string>;
  langLabel: Record<ScriptCatLang, string>;
  previewLabel: Record<ScriptCatLang, string>;
  overwriteLabel: Record<ScriptCatLang, string>;
  copyFailedLabel: Record<ScriptCatLang, string>;
}

export const texts: ScriptCatTexts = {
  panelTitle: {
    zh: 'DUKO 填入器',
    en: 'DUKO Filler',
  },
  minimize: {
    zh: '最小化',
    en: 'Minimize',
  },
  close: {
    zh: '关闭',
    en: 'Close',
  },
  csvLabel: {
    zh: '粘贴 CSV（productName,quantity）：',
    en: 'Paste CSV (productName,quantity):',
  },
  writeBtn: {
    zh: '一键写入 Odoo',
    en: 'Fill Odoo',
  },
  statusReady: {
    zh: '就绪',
    en: 'Ready',
  },
  statusWriting: {
    zh: '写入中...',
    en: 'Writing...',
  },
  statusDone: {
    zh: '写入完成：',
    en: 'Done: ',
  },
  statusPartial: {
    zh: '部分成功：',
    en: 'Partial: ',
  },
  statusError: {
    zh: '写入失败：所有行均未匹配到产品',
    en: 'Failed: no products matched',
  },
  statusErrMsg: {
    zh: '错误：',
    en: 'Error: ',
  },
  colModel: {
    zh: '型号',
    en: 'Model',
  },
  colQty: {
    zh: '数量',
    en: 'Qty',
  },
  interceptAlert: {
    zh: '以下写入操作被 odoo 拦截！',
    en: 'Odoo blocked the following writes!',
  },
  langLabel: {
    zh: 'English',
    en: '中文',
  },
  previewLabel: {
    zh: '预览：',
    en: 'Preview: ',
  },
  overwriteLabel: {
    zh: '覆写模式（对比已有行，删不在新列表中的，追加新内容）',
    en: 'Overwrite (remove rows not in new list, append new items)',
  },
  copyFailedLabel: {
    zh: '以下型号写入失败（可全选复制到上方输入框）：',
    en: 'These models failed to write (select all, copy to input above):',
  },
};

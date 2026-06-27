/**
 * 国际化 React Context
 *
 * 提供当前语言、切换语言、翻译函数。
 * 语言检测优先级：localStorage('duko_lang') → navigator.language → 'en'
 */
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { messages, type Lang, type TranslationKey } from './translations';

/** 存储键名 */
const STORAGE_KEY = 'duko_lang';

/** 检测浏览器/系统默认语言 */
function detectLang(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'zh' || stored === 'en') return stored;
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith('zh')) return 'zh';
  return 'en';
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((newLang: Lang) => {
    localStorage.setItem(STORAGE_KEY, newLang);
    document.documentElement.lang = newLang === 'zh' ? 'zh-CN' : 'en';
    setLangState(newLang);
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>): string => {
      let text: string = messages[key]?.[lang] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(`{${k}}`, String(v));
        }
      }
      return text;
    },
    [lang],
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

/** 在组件中使用国际化上下文 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return ctx;
}

/** 在非 React 环境中获取翻译文本（如 Zustand store） */
export function tOutside(key: TranslationKey, params?: Record<string, string | number>): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  const lang: Lang = stored === 'zh' || stored === 'en' ? stored : 'en';
  let text: string = messages[key]?.[lang] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}

/** 在非 React 环境中获取当前语言 */
export function getLang(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'zh' || stored === 'en' ? stored : 'en';
}

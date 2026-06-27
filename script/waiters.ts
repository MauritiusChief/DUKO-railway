// DOM 等待工具 —— 替代 Playwright 的 waitFor 系列 API
// 实现方式：MutationObserver 监听 DOM 变化 + requestAnimationFrame 轮询 + setTimeout 超时

/**
 * 等待某个 CSS 选择器在 DOM 中出现且可见（非 display:none / visibility:hidden）
 * @param timeout - 超时毫秒，默认 10000
 * @returns 匹配的 Element，超时则 reject
 */
export function waitForSelector(
  selector: string,
  timeout = 10000,
): Promise<Element> {
  return new Promise((resolve, reject) => {
    // 先检查是否已存在
    const existing = checkVisible(selector);
    if (existing) return resolve(existing);

    const start = Date.now();
    let observer: MutationObserver | null = null;
    let rafId = 0;
    let timerId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      observer?.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
    };

    const check = () => {
      const el = checkVisible(selector);
      if (el) {
        cleanup();
        resolve(el);
        return true;
      }
      return false;
    };

    // MutationObserver：DOM 变化时立即检查
    observer = new MutationObserver(() => check());
    observer.observe(document.body, { childList: true, subtree: true });

    // requestAnimationFrame 轮询作为兜底
    const poll = () => {
      if (!check()) {
        rafId = requestAnimationFrame(poll);
      }
    };
    rafId = requestAnimationFrame(poll);

    // 超时
    timerId = setTimeout(() => {
      cleanup();
      reject(new Error(`waitForSelector 超时: ${selector}`));
    }, timeout);
  });
}

/** 检查选择器是否存在且可见 */
function checkVisible(selector: string): Element | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return null;
  return el;
}

/**
 * 等待某个元素从 DOM 中消失
 * @param timeout - 超时毫秒
 */
export function waitForElementRemoved(
  selector: string,
  timeout = 10000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 已不存在则立即返回
    if (!document.querySelector(selector)) return resolve();

    const start = Date.now();
    let observer: MutationObserver | null = null;
    let timerId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      observer?.disconnect();
      clearTimeout(timerId);
    };

    const check = () => {
      if (!document.querySelector(selector)) {
        cleanup();
        resolve();
        return true;
      }
      return false;
    };

    observer = new MutationObserver(() => {
      if (check()) cleanup();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    timerId = setTimeout(() => {
      cleanup();
      // waitForElementRemoved 超时不视为硬错误，resolve 即可
      resolve();
    }, timeout);
  });
}

/**
 * 等待某个元素的文本内容包含指定字符串
 * @param timeout - 超时毫秒
 * @returns 是否匹配成功
 */
export function waitForText(
  selector: string,
  text: string,
  timeout = 10000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    let observer: MutationObserver | null = null;
    let rafId = 0;
    let timerId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      observer?.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
    };

    const check = (): boolean => {
      const el = document.querySelector(selector);
      if (!el) return false;
      if (el.textContent?.toLowerCase().includes(text.toLowerCase())) {
        cleanup();
        resolve(true);
        return true;
      }
      return false;
    };

    check();

    observer = new MutationObserver(() => check());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    const poll = () => {
      if (!check()) rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);

    timerId = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeout);
  });
}

/**
 * 延迟指定毫秒
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待 autocomplete 下拉菜单的真实结果加载完成。
 * Odoo 在输入型号后先显示 "Loading..." 占位，后端返回后才替换为真实列表项。
 * 这里轮询直到至少有一个列表项不含 "Loading..." 文字。
 *
 * @param selector - 下拉项选择器
 * @param timeout - 超时毫秒，默认 8000
 */
export function waitForDropdownReady(
  selector: string,
  timeout = 8000,
): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    let observer: MutationObserver | null = null;
    let rafId = 0;
    let timerId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      observer?.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
    };

    const check = (): boolean => {
      const items = document.querySelectorAll(selector);
      if (items.length > 0) {
        const hasRealItem = Array.from(items).some(
          (el) => !(el.textContent ?? '').includes('Loading'),
        );
        if (hasRealItem) {
          cleanup();
          resolve();
          return true;
        }
      }
      return false;
    };

    check();

    observer = new MutationObserver(() => {
      if (check()) cleanup();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const poll = () => {
      if (!check()) rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);

    timerId = setTimeout(() => {
      cleanup();
      resolve();
    }, timeout);
  });
}

/**
 * 等待选择器匹配的元素数量降到阈值以下（用于确认行删除生效）。
 *
 * @param selector - CSS 选择器
 * @param threshold - 期望降到多少以下
 * @param timeout - 超时毫秒，默认 5000
 */
export function waitForCountDecrease(
  selector: string,
  threshold: number,
  timeout = 5000,
): Promise<void> {
  return new Promise((resolve) => {
    if (document.querySelectorAll(selector).length < threshold) return resolve();

    const start = Date.now();
    let observer: MutationObserver | null = null;
    let rafId = 0;
    let timerId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      observer?.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
    };

    const check = (): boolean => {
      if (document.querySelectorAll(selector).length < threshold) {
        cleanup();
        resolve();
        return true;
      }
      return false;
    };

    observer = new MutationObserver(() => {
      if (check()) cleanup();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const poll = () => {
      if (!check()) rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);

    timerId = setTimeout(() => {
      cleanup();
      resolve();
    }, timeout);
  });
}

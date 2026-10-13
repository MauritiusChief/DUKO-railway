// 所有等待都限定于传入的根节点，超时必须明确失败。
export type QueryRoot = Document | Element;

export function waitUntil(
  predicate: () => boolean,
  timeout = 10000,
  root: QueryRoot = document,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate()) return resolve();
    let rafId = 0;
    let settled = false;
    let timerId: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => check());
    const cleanup = () => {
      settled = true;
      observer.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
    };
    const check = () => {
      if (settled) return true;
      try {
        if (!predicate()) return false;
        cleanup();
        resolve();
      } catch (error) {
        cleanup();
        reject(error);
      }
      return true;
    };
    observer.observe(root instanceof Document ? root.body : root, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
    const poll = () => {
      if (!check()) rafId = requestAnimationFrame(poll);
    };
    timerId = setTimeout(() => {
      cleanup();
      reject(new Error('等待 Odoo 页面变化超时'));
    }, timeout);
    rafId = requestAnimationFrame(poll);
  });
}

/** 同时检查祖先，避免命中隐藏的标签页或表格。 */
export function isVisible(element: Element): boolean {
  if (!element.isConnected) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

export async function waitForSelector(
  selector: string,
  timeout = 10000,
  root: QueryRoot = document,
): Promise<Element> {
  let found: Element | undefined;
  await waitUntil(() => {
    found = Array.from(root.querySelectorAll(selector)).find(isVisible);
    return !!found;
  }, timeout, root);
  return found!;
}

export function waitForElementRemoved(selector: string, timeout = 10000, root: QueryRoot = document): Promise<void> {
  return waitUntil(() => !root.querySelector(selector), timeout, root);
}

export function waitForDropdownReady(selector: string, timeout = 8000, root: QueryRoot = document): Promise<void> {
  return waitUntil(() => Array.from(root.querySelectorAll(selector)).some(
    (item) => !(item.textContent ?? '').includes('Loading'),
  ), timeout, root);
}

export function waitForCountDecrease(selector: string, threshold: number, timeout = 5000, root: QueryRoot = document): Promise<void> {
  return waitUntil(() => root.querySelectorAll(selector).length < threshold, timeout, root);
}

import { JSDOM } from 'jsdom';

/** 宿主回执模拟：记录 webview→宿主消息，并可将宿主消息推回 webview。 */
export interface FakeHost {
  /** webview 经 acquireVsCodeApi.postMessage 发出的消息（按序）。 */
  posted: unknown[];
  /** 模拟宿主向 webview 推送一条消息（经 globalThis 'message' 事件，RpcBus 据此分发）。 */
  receive(msg: unknown): void;
  dom: JSDOM;
}

/**
 * 在 node 环境装配最小 webview DOM（jsdom）+ 伪 acquireVsCodeApi + 必要浏览器桩，
 * 供 webviewEntry 冒烟测试。须在 dynamic import('../webviewEntry.ts') 之前调用，
 * 因为 webviewEntry 模块加载即挂载 main()。
 */
export function setupWebviewDom(): FakeHost {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>',
    { url: 'https://jsonl-viewer.example/', pretendToBeVisual: true }
  );
  const { window } = dom;
  const g = globalThis as unknown as Record<string, unknown>;

  // 安全注入全局：Node 22 部分全局（如 navigator）为只读 getter，直接赋值抛错。
  // 兜底用 defineProperty；仍失败则跳过——webview 代码均经 window.* 取用，不受影响。
  const setGlobal = (key: string, value: unknown): void => {
    try {
      g[key] = value;
    } catch {
      try {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
      } catch {
        /* 只读全局，跳过 */
      }
    }
  };

  // 暴露浏览器全局给 webview 代码
  setGlobal('window', window);
  setGlobal('document', window.document);
  setGlobal('localStorage', window.localStorage);
  setGlobal('navigator', window.navigator);
  setGlobal('HTMLElement', window.HTMLElement);
  setGlobal('Node', window.Node);
  setGlobal('MessageEvent', window.MessageEvent);
  setGlobal('Event', window.Event);

  // matchMedia（jsdom 未实现）→ 默认不匹配（走非 reduce-motion 动画路径）
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });
  (window as unknown as { matchMedia: unknown }).matchMedia = matchMedia;
  g.matchMedia = matchMedia;

  // ResizeObserver（jsdom 未实现）→ no-op 桩
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  g.ResizeObserver = ResizeObserverStub;
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

  // 把 window 事件系统桥接到 globalThis（RpcBus 监听 globalThis 'message'）
  g.addEventListener = window.addEventListener.bind(window);
  g.removeEventListener = window.removeEventListener.bind(window);
  g.dispatchEvent = window.dispatchEvent.bind(window);

  // 动画帧 API：生产代码用**裸** requestAnimationFrame（非 window.rAF），
  // jsdom 只在 window 上提供，须显式桥接到 globalThis，否则视图层动画回调会抛
  // "requestAnimationFrame is not defined"。
  setGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  setGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));

  // 伪 acquireVsCodeApi：仅记录 webview→宿主消息
  const posted: unknown[] = [];
  g.acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => {
      posted.push(msg);
    },
    getState: () => ({}),
    setState() {},
  });

  // 所有定时器 unref，避免挂载时的握手超时定时器（INIT_TIMEOUT_MS）阻塞测试进程退出。
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: (...a: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const t = realSetTimeout(fn as TimerHandler, ms as number, ...args);
    const withUnref = t as { unref?: () => void };
    if (typeof withUnref.unref === 'function') withUnref.unref();
    return t;
  }) as typeof setTimeout;

  const fakeHost: FakeHost = {
    posted,
    dom,
    receive(msg: unknown) {
      window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
    },
  };
  return fakeHost;
}

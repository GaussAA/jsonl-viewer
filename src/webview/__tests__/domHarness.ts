import { JSDOM } from 'jsdom';

/** 宿主回执模拟：记录 webview→宿主消息，并可将宿主消息推回 webview。 */
export interface FakeHost {
  /** webview 经 acquireVsCodeApi.postMessage 发出的消息（按序）。 */
  posted: unknown[];
  /** 模拟宿主向 webview 推送一条消息（经 globalThis 'message' 事件，RpcBus 据此分发）。 */
  receive(msg: unknown): void;
  /**
   * 读取当前 webview 自持久状态（`getState` 的落点）。
   *
   * 真实 VS Code 会在面板重建时把它原样交回；这里如实保存，便于断言
   * 「栏宽 / 折叠态」这类 UI 偏好确实落盘。
   */
  state: () => Record<string, unknown>;
  /** 替换 setState 实现（用于模拟写入失败等异常路径）。 */
  setStateImpl: (fn: (s: unknown) => void) => void;
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

  // scrollIntoView（jsdom 未实现）→ no-op 桩。
  //
  // 视图层的「跳到命中的那一条」「把选中项滚进视野」都会调它；jsdom 没有布局引擎，
  // 真滚也滚不动，但**不能没有这个方法** —— 否则调用处会抛 TypeError，
  // 表现为「某个交互一用就静默失效」（事件回调里的异常不会让断言失败，只会让状态停在半路）。
  const scrollIntoViewStub = function scrollIntoView(): void {};
  const proto = window.Element?.prototype as unknown as Record<string, unknown> | undefined;
  if (proto) {
    proto.scrollIntoView = scrollIntoViewStub;
    // scrollTo / scrollBy 同理（列表滚动复位会用到）。
    if (typeof proto.scrollTo !== 'function') proto.scrollTo = function scrollTo(): void {};
  }

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

  // 伪 acquireVsCodeApi：记录 webview→宿主消息，并**如实保存** webview state
  // （真实宿主会在面板重建时把它交回；保存起来才能断言 UI 偏好是否落盘）。
  const posted: unknown[] = [];
  let webviewState: unknown = {};
  let setStateImpl: (s: unknown) => void = (s: unknown) => {
    webviewState = s;
  };
  g.acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => {
      posted.push(msg);
    },
    getState: () => webviewState,
    setState: (s: unknown) => setStateImpl(s),
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
    state: () =>
      webviewState && typeof webviewState === 'object'
        ? (webviewState as Record<string, unknown>)
        : {},
    setStateImpl: (fn) => {
      setStateImpl = fn;
    },
    receive(msg: unknown) {
      window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
    },
  };
  return fakeHost;
}

/**
 * serviceRegistry.ts — 按 key 复用 + 引用计数的服务注册表（从 extension.ts 抽出，T4/A4）。
 *
 * 为何单独成模块：
 *   1. 原先 `serviceRegistry` 是 extension.ts 的**模块级隐式全局**，无法单测、难注入；
 *   2. 注册表本身与 VS Code 无关（纯 Map + 引用计数 + dispose 上报），抽成纯模块后可直接单测
 *      「复用 / 计数 / 归零释放 / 释放异常不外抛」，并由 activate() 显式创建实例后注入调用方。
 *
 * 语义（与抽取前逐条一致）：
 *   - acquire 命中 → 复用并 +1 引用；未命中 → create() 新建并置引用为 1（create 仅未命中时调用，
 *     故不会重复建索引 / 重复起 worker / 重复占文件句柄）；
 *   - release 递减；归零时删除条目并 dispose；
 *   - 未知 key 的 release 幂等忽略（重复释放不抛）。
 */

/** 注册表所管理的资源：须可释放（dispose 返回 Promise）。 */
export interface AsyncDisposableLike {
  dispose(): Promise<unknown>;
}

export interface ServiceRegistry<T extends AsyncDisposableLike> {
  /**
   * 取用该 key 的资源：命中则复用并 +1 引用；未命中则以 create() 新建并置引用为 1。
   * `create` 仅在未命中时调用。
   */
  acquire(key: string, create: () => T): T;
  /**
   * 释放一次引用；引用归零时删除条目并 dispose。
   * dispose 的失败（同步抛 / Promise reject）一律经 `onReleaseError` 上报，**绝不外抛**——
   * 扩展宿主是所有扩展共享的进程，一次释放异常不得击穿它。
   */
  release(key: string): void;
  /** 当前受管条目数（诊断 / 测试）。 */
  size(): number;
  /** 该 key 的当前引用数；不存在返回 0（诊断 / 测试）。 */
  refsOf(key: string): number;
}

export function createServiceRegistry<T extends AsyncDisposableLike>(
  onReleaseError: (e: unknown) => void = () => {}
): ServiceRegistry<T> {
  const entries = new Map<string, { svc: T; refs: number }>();

  return {
    acquire(key, create) {
      const hit = entries.get(key);
      if (hit) {
        hit.refs++;
        return hit.svc;
      }
      const svc = create();
      entries.set(key, { svc, refs: 1 });
      return svc;
    },

    release(key) {
      const hit = entries.get(key);
      if (!hit) return; // 未知 key：幂等忽略
      hit.refs--;
      if (hit.refs > 0) return;
      entries.delete(key);
      // 归零才真正释放。同步抛与异步 reject 均须收口上报，避免击穿扩展宿主。
      try {
        void Promise.resolve(hit.svc.dispose()).catch(onReleaseError);
      } catch (e) {
        onReleaseError(e);
      }
    },

    size: () => entries.size,
    refsOf: (key) => entries.get(key)?.refs ?? 0,
  };
}

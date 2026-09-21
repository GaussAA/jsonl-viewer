import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom, type FakeHost } from './domHarness.ts';
import { HostEndpoint, HostReply } from '../../protocol/rpc.ts';

/**
 * webviewEntry 冒烟测试（jsdom 回归网）。
 *
 * 价值：T5 将把 main() 近 490 行的协调器拆为 columnLayout / queryActions / persistence 等模块。
 * 此测试在每次重构后验证「模块加载即挂载 main() 不抛错 + 关键组件已接线 + ready 握手已发 +
 * 宿主 init 回执可安全处理」，作为 DOM 装配层的回归护栏（不验证深层业务逻辑）。
 */
describe('webviewEntry 冒烟测试（jsdom）', () => {
  let host: FakeHost;

  before(async () => {
    host = setupWebviewDom();
    // 装配 DOM 后动态 import，触发 webviewEntry 顶层 main() 挂载（静态 import 会在 DOM 装配前执行）。
    await import('../webviewEntry.ts');
  });

  it('main() 成功导出且 #app 根节点存在', () => {
    const app = globalThis.document.getElementById('app');
    assert.ok(app, '#app 根节点存在');
  });

  it('关键组件已挂入 #app（工具栏/列表/详情/横幅/左右栏）', () => {
    const app = globalThis.document.getElementById('app')!;
    assert.ok(app.querySelector('.jlv-toolbar'), '工具栏已挂载');
    assert.ok(app.querySelector('.jlv-list-wrap'), '虚拟列表已挂载');
    assert.ok(app.querySelector('.jlv-detail-header'), '详情面板已挂载');
    assert.ok(app.querySelector('.jlv-banner'), '横幅已挂载');
    assert.ok(app.querySelector('.jlv-col-list'), '左栏已挂载');
    assert.ok(app.querySelector('.jlv-resizer'), '拖拽条已挂载');
  });

  it('挂载后 webview 已发出 ready 握手', () => {
    const ready = (host.posted as { type?: unknown }[]).some((m) => m.type === HostEndpoint.READY);
    assert.ok(ready, 'webview 已发出 ready 握手消息');
  });

  it('宿主 init 回执可被安全处理（不抛错）', () => {
    assert.doesNotThrow(() => {
      host.receive({
        type: HostReply.INIT,
        requestId: 'init-1',
        payload: {
          totalLines: 3,
          totalBytes: 10,
          badLines: 0,
          sampledFields: [],
          parsedLines: 3,
          truncated: false,
          fileName: 'sample.jsonl',
        },
      });
    });
  });
});

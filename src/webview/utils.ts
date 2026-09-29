/**
 * utils.ts — 纯函数小工具集合。
 * 独立文件：不导入任何运行时类，方便被 Node strip-only loader 的测试直接引用。
 */

/** 将用户数据中危险的 HTML 特殊字符转义，防止 innerHTML 注入 XSS。 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default: // '
        return '&#39;';
    }
  });
}

/** 截断字符串到最大长度，超长追加省略号。 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * 把文本渲染进元素，并把命中片段包成 `<mark>`。
 *
 * 为何用 DOM 节点而非 innerHTML 拼接：文本来自用户数据，任何字符串拼接都必须先转义；
 * 而「转义后再拼 <mark>」这条路一错就是 XSS。这里全程 `createTextNode` +
 * `document.createElement('mark')`，**用户数据永远进不了 HTML 解析器**。
 */
export function renderHighlight(
  el: HTMLElement,
  text: string,
  ranges: readonly (readonly [number, number])[]
): void {
  el.textContent = '';
  if (ranges.length === 0) {
    el.appendChild(el.ownerDocument.createTextNode(text));
    return;
  }
  const doc = el.ownerDocument;
  let cursor = 0;
  for (const [start, end] of ranges) {
    // 防御：区间必须有序且不越界，否则宁可放弃高亮也不要错位显示。
    if (start < cursor || end > text.length || start >= end) continue;
    if (start > cursor) el.appendChild(doc.createTextNode(text.slice(cursor, start)));
    const mark = doc.createElement('mark');
    mark.className = 'jlv-hit';
    mark.textContent = text.slice(start, end);
    el.appendChild(mark);
    cursor = end;
  }
  if (cursor < text.length) el.appendChild(doc.createTextNode(text.slice(cursor)));
}

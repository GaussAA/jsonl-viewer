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

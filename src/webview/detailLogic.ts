/**
 * detailLogic.ts — JSON 树详情面板的纯逻辑层（无 DOM / 无 vscode 依赖，可 node:test 单测）。
 *
 * 与 logic.ts 分离，职责聚焦「树的形状与状态」：
 *   - JSON 值分类（类型着色映射）。
 *   - 路径模型：PathSeg（key/index）、路径字符串、无歧义的路径 key。
 *   - 折叠状态：Set(collapsed 路径) + 展开深度上限 + 超出上限的强制展开覆盖（面包屑导航用）。
 *   - 大数组分段预览：对大数组只计算首屏应渲染的项数与剩余项数，避免一次性生成海量 DOM。
 *
 * DOM 渲染（detailTree.ts）只消费这里提供的纯函数/类，不承担任何树形逻辑。
 */

/* ------------------------------ 类型 / 常量 ------------------------------ */

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/** 路径段：对象键（key）或数组下标（index）。 */
export interface PathSeg {
  kind: 'key' | 'index';
  /** 对象键名（可为空字符串）或数组下标的字符串形式。 */
  key: string;
}

/** 大数组首屏渲染项数；超出后进入「分段预览」（仅渲染这些项 + 剩余计数）。 */
export const LARGE_ARRAY_PREVIEW = 50;
/** 对象字段数硬上限（防御：对象字段数通常可控，仍给兜底）。 */
export const OBJECT_HARD_CAP = 2000;
/** 展开递归的最大深度（防止"全部展开"在病态深层结构上失控）。 */
export const MAX_RENDER_DEPTH = 400;

/* ------------------------------ JSON 值分类 ------------------------------ */

export function jsonKindOf(value: unknown): JsonKind {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  return 'object'; // 其余（bigint/undefined 之外的 plain object）
}

/** 是否为可折叠容器（对象/数组）。 */
export function isContainer(value: unknown): boolean {
  const k = jsonKindOf(value);
  return k === 'object' || k === 'array';
}

/* ------------------------------ 路径 ------------------------------ */

/**
 * 无歧义的路径 key：kind 前缀 + JSON 编码段，以不可见分隔符拼接。
 * 用于 Set/Map/Record 的键（避免对象 key 内含 `.`/`[`/`]` 造成歧义）。
 */
export function pathKey(segs: PathSeg[]): string {
  if (segs.length === 0) return '$';
  return segs.map((s) => `${s.kind === 'key' ? 'k' : 'i'}:${JSON.stringify(s.key)}`).join('\u0000');
}

/** 数组下标的规则（用于面包屑展示）。 */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 单个路径段的显示文本：对象键 `.name`（特殊字符则 `["k"]`），下标 `[3]`。 */
export function segText(seg: PathSeg): string {
  if (seg.kind === 'index') return `[${seg.key}]`;
  return IDENT_RE.test(seg.key) ? `.${seg.key}` : `[${JSON.stringify(seg.key)}]`;
}

/** 路径数组 -> 展示字符串，如 `.a[3].b`；顶层（空数组）为 ''。 */
export function pathToString(segs: PathSeg[]): string {
  let out = '';
  for (const s of segs) out += segText(s);
  return out;
}

/* ------------------------------ 折叠状态 ------------------------------ */

export class TreeState {
  private readonly collapsed = new Set<string>();
  /** 被强制展开的路径（超出展开深度上限，由面包屑导航/手动展开创建）。 */
  private readonly expandedOverrides = new Set<string>();
  private depthLimit: number;

  constructor(depthLimit = 1) {
    this.depthLimit = depthLimit;
  }

  get maxDepth(): number {
    return this.depthLimit;
  }

  /** 只读视图（供测试/工具访问）已折叠路径集合。 */
  collapseKeys(): ReadonlySet<string> {
    return this.collapsed;
  }

  /**
   * 节点当前是否渲染为「展开」（即显示其子项）。
   * root（depth 0）恒展开；显式折叠优先；强制展开覆盖；否则取决于展开深度上限。
   */
  isExpanded(segs: PathSeg[], depth: number): boolean {
    if (depth === 0) return true;
    const k = pathKey(segs);
    if (this.collapsed.has(k)) return false;
    if (this.expandedOverrides.has(k)) return true;
    return depth <= this.depthLimit;
  }

  /** 反敛切换：当前展开则折叠，否则展开。返回切换后是否展开。 */
  toggle(segs: PathSeg[], depth: number): boolean {
    const k = pathKey(segs);
    if (this.isExpanded(segs, depth)) {
      this.collapsed.add(k);
      this.expandedOverrides.delete(k);
      return false;
    }
    this.collapsed.delete(k);
    this.expandedOverrides.add(k);
    return true;
  }

  /** 强制展开某节点（无论深度上限）。用于面包屑导航定位深层节点。 */
  forceExpand(segs: PathSeg[]): void {
    if (segs.length === 0) return;
    const k = pathKey(segs);
    this.collapsed.delete(k);
    this.expandedOverrides.add(k);
  }

  /** 全部折叠：只保留 root 展开，清空所有非 root 的展开。 */
  collapseAll(): void {
    this.depthLimit = 0;
    this.collapsed.clear();
    this.expandedOverrides.clear();
  }

  /** 全部展开：直到最大渲染深度，清空覆盖。 */
  expandAll(): void {
    this.depthLimit = MAX_RENDER_DEPTH;
    this.collapsed.clear();
    this.expandedOverrides.clear();
  }

  /** 展开到第 N 层（N>=1），清空覆盖。 */
  expandToLevel(n: number): void {
    this.depthLimit = Math.max(1, Math.floor(n));
    this.collapsed.clear();
    this.expandedOverrides.clear();
  }
}

/* ------------------------------ 大数组分段 / 子项展开 ------------------------------ */

/** 大数组分段计：可见项数与剩余项数（revealedExtra 为已通过「加载更多」增加的额外项）。 */
export function arraySegmentCount(
  length: number,
  revealedExtra: number
): { visible: number; remaining: number } {
  const visible = Math.min(length, LARGE_ARRAY_PREVIEW + Math.max(0, revealedExtra));
  return { visible, remaining: length - visible };
}

/** 「加载更多」已额外展开数量的映射：父节点 pathKey -> 额外项数。 */
export type RevealMap = Readonly<Record<string, number>>;

/** 渲染出的一个直接子项（不递归展开，仅平铺一层）。 */
export interface ChildItem {
  seg: PathSeg;
  value: unknown;
  kind: JsonKind;
}

/**
 * 展开一个容器节点，返回「应渲染」的直接子项序列与剩余计数。
 * - 数组：遵循分段预览（仅返回首屏 visible 项），remaining > 0 表示可「加载更多」；
 * - 对象：在硬上限内全部返回（字段数通常可控），下标恒有限。
 *
 * parentKey 为父节点 pathKey（用于查该数组的「加载更多」reveal 计数）。
 */
export function expandContainer(
  value: object,
  parentKey: string,
  revealed: RevealMap
): { items: ChildItem[]; remaining: number } {
  if (Array.isArray(value)) {
    const { visible, remaining } = arraySegmentCount(value.length, revealed[parentKey] ?? 0);
    const items: ChildItem[] = [];
    for (let i = 0; i < visible; i++) {
      const v = value[i];
      items.push({ seg: { kind: 'index', key: String(i) }, value: v, kind: jsonKindOf(v) });
    }
    return { items, remaining };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const cap = Math.min(entries.length, OBJECT_HARD_CAP);
  const items: ChildItem[] = [];
  for (let i = 0; i < cap; i++) {
    const [k, v] = entries[i];
    items.push({ seg: { kind: 'key', key: k }, value: v, kind: jsonKindOf(v) });
  }
  return { items, remaining: 0 };
}

/** 容器折叠时的摘要文本（如 `{…} 5 fields`、`[…] 12 items`）。 */
export function containerPreview(value: object): string {
  if (Array.isArray(value)) {
    const n = value.length;
    return `[…] ${n} item${n === 1 ? '' : 's'}`;
  }
  const n = Object.keys(value as Record<string, unknown>).length;
  return `{…} ${n} field${n === 1 ? '' : 's'}`;
}

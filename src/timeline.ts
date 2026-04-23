import type { TraceSpan } from './parser';

const THREAD_COLORS: Record<string, string> = {
  MAIN: '#ff7043',
  RUN: '#4a9eff',
  TRANS: '#66bb6a',
};

function getColor(thread: string): string {
  return THREAD_COLORS[thread] ?? '#90a4ae';
}

function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, '');
}

// ns 数值 -> 自适应单位字符串，用于 Duration / Tooltip
function formatDurationNs(ns: number): string {
  const abs = Math.abs(ns);

  if (!Number.isFinite(ns)) return '-';
  if (abs === 0) return '0ns';

  if (abs < 1_000) {
    return `${trimZeros(ns.toFixed(0))}ns`;
  }

  if (abs < 1_000_000) {
    return `${trimZeros((ns / 1_000).toFixed(3))}us`;
  }

  if (abs < 1_000_000_000) {
    return `${trimZeros((ns / 1_000_000).toFixed(3))}ms`;
  }

  return `${trimZeros((ns / 1_000_000_000).toFixed(6))}s`;
}

// 时间偏移显示，用于 Start / End / 鼠标位置等
function formatTimeOffsetNs(ns: number): string {
  return formatDurationNs(ns);
}

// 根据当前坐标轴 tick step 来选择单位
function formatAxisNs(ns: number, stepNs: number): string {
  if (!Number.isFinite(ns) || !Number.isFinite(stepNs)) return '-';

  const absStep = Math.abs(stepNs);

  if (absStep < 1_000) {
    return `${trimZeros(ns.toFixed(0))}ns`;
  }

  if (absStep < 1_000_000) {
    return `${trimZeros((ns / 1_000).toFixed(3))}us`;
  }

  if (absStep < 1_000_000_000) {
    return `${trimZeros((ns / 1_000_000).toFixed(3))}ms`;
  }

  return `${trimZeros((ns / 1_000_000_000).toFixed(6))}s`;
}

// 根据当前可见范围 ns 选择合适的刻度步长 ns
function calcTickStep(visibleNs: number, maxTicks: number): number {
  const raw = visibleNs / maxTicks;

  if (!Number.isFinite(raw) || raw <= 0) return 1;

  const exponent = Math.floor(Math.log10(raw));
  const magnitude = Math.pow(10, exponent);
  const normalized = raw / magnitude;

  let nice: number;

  if (normalized <= 1) {
    nice = 1;
  } else if (normalized <= 2) {
    nice = 2;
  } else if (normalized <= 5) {
    nice = 5;
  } else {
    nice = 10;
  }

  return nice * magnitude;
}

interface Group {
  id: string;
  label: string;
  color: string;
  indent: number;
  order: number;
}

interface Item {
  id: string | number;
  groupId: string;
  startNs: number;
  endNs: number;
  color: string;
  label: string;
  tooltip: string;
  incomplete?: boolean;
  missingEnd?: boolean;
  orphanEnd?: boolean;
}

const ROW_HEIGHT = 25;
const HEADER_HEIGHT = 38;
const LEFT_PANEL = 100;
const MIN_ITEM_WIDTH = 1;

export class TraceTimeline {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private container!: HTMLElement;
  private resizeObserver!: ResizeObserver;

  private groups: Group[] = [];
  private items: Item[] = [];

  // 视口：可见范围的起止 ns
  private viewStart = 0;
  private viewEnd = 1;

  // 数据范围
  private dataStart = 0;
  private dataEnd = 1;

  // 拖动状态
  private dragging = false;
  private dragStartX = 0;
  private dragStartViewStart = 0;
  private dragStartViewEnd = 0;

  // hover tooltip
  private mouseX = -1;
  private mouseY = -1;
  private hoveredItem: Item | null = null;

  // Alt 临时测量游标
  private measureMode = false;
  private cursorA: number | null = null;
  private cursorB: number | null = null;
  private nextCursor: 'A' | 'B' = 'A';

  // 垂直滚动
  private scrollY = 0;

  private animFrame = 0;

  init(container: HTMLElement, _onDoubleClick?: () => void) {
    this.container = container;

    container.style.position = 'relative';
    container.style.overflow = 'hidden';

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'display:block;width:100%;height:100%;cursor:default;';
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d not supported');

    this.ctx = ctx;

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);
    this.onResize();

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('dblclick', this.onDblClick);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    this.canvas.addEventListener('mouseleave', () => {
      this.mouseX = -1;
      this.mouseY = -1;
      this.hoveredItem = null;
      this.scheduleRender();
    });
  }

  private onResize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scheduleRender();
  }

  // ── 数据更新 ──────────────────────────────────────────────────────────────

  update(spans: TraceSpan[], visibleTasks: Set<string>, fitView = false) {
    const visible = spans.filter((s) => visibleTasks.has(s.task));

    const threadOrder: Record<string, number> = {
      MAIN: 1,
      RUN: 2,
      TRANS: 3,
    };

    const groupMap = new Map<string, Group>();
    const tasksByThread = new Map<string, string[]>();
    const incompleteTaskSet = new Set<string>();

    for (const s of visible) {
      if (!tasksByThread.has(s.thread)) {
        tasksByThread.set(s.thread, []);
      }

      const arr = tasksByThread.get(s.thread)!;

      if (!arr.includes(s.task)) {
        arr.push(s.task);
      }

      if (s.incomplete) {
        incompleteTaskSet.add(s.task);
      }
    }

    for (const [thread, tasks] of tasksByThread) {
      const base = threadOrder[thread] ?? 99;
      const lifecycle = tasks.find((t) => t === thread);

      if (lifecycle && !groupMap.has(lifecycle)) {
        groupMap.set(lifecycle, {
          id: lifecycle,
          label: incompleteTaskSet.has(lifecycle)
            ? `${lifecycle} *`
            : lifecycle,
          color: getColor(thread),
          indent: 0,
          order: base,
        });
      }

      tasks
        .filter((t) => t !== thread)
        .sort()
        .forEach((task, idx) => {
          if (!groupMap.has(task)) {
            const shortLabel = task.split('.')[1] ?? task;

            groupMap.set(task, {
              id: task,
              label: incompleteTaskSet.has(task)
                ? `${shortLabel} *`
                : shortLabel,
              color: getColor(thread),
              indent: 16,
              order: base + 0.001 * (idx + 1),
            });
          }
        });
    }

    this.groups = Array.from(groupMap.values()).sort(
      (a, b) => a.order - b.order
    );

    const rawItems = visible.map((s) => {
      const startNs = Number(s.start_ns);
      const endNs = Number(s.end_ns);

      return {
        span: s,
        startNs,
        endNs,
      };
    });

    if (rawItems.length > 0) {
      this.dataStart = Math.min(...rawItems.map((i) => i.startNs));
      this.dataEnd = Math.max(...rawItems.map((i) => i.endNs));
    } else {
      this.dataStart = 0;
      this.dataEnd = 1;
    }

    this.items = rawItems.map(({ span: s, startNs, endNs }) => {
      const durationNs = endNs - startNs;

      const status = s.missingEnd
        ? 'Missing END'
        : s.orphanEnd
        ? 'END without START'
        : 'Complete';

      return {
        id: s.id,
        groupId: s.task,
        startNs,
        endNs,
        color: getColor(s.thread),
        label: s.task.includes('.')
          ? s.missingEnd
            ? `${s.task.split('.')[1]} *`
            : s.task.split('.')[1]
          : s.missingEnd
          ? `${s.task} *`
          : s.task,
        incomplete: s.incomplete,
        missingEnd: s.missingEnd,
        orphanEnd: s.orphanEnd,
        tooltip: [
          s.task,
          `Duration: ${formatDurationNs(durationNs)}`,
          `Start: ${formatTimeOffsetNs(startNs - this.dataStart)}`,
          `End:   ${formatTimeOffsetNs(endNs - this.dataStart)}`,
          `Status: ${status}`,
        ].join('\n'),
      };
    });

    if (fitView || this.viewStart === this.viewEnd) {
      this.fitView();
    }

    this.scheduleRender();
  }

  // ── 视口操作 ──────────────────────────────────────────────────────────────

  fitView() {
    const range = this.dataEnd - this.dataStart;
    const padding = range * 0.02 || 1_000;

    this.viewStart = this.dataStart - padding;
    this.viewEnd = this.dataEnd + padding;
    this.scrollY = 0;
  }

  fit() {
    this.fitView();
    this.scheduleRender();
  }

  private chartWidth(): number {
    return Math.max(1, this.container.clientWidth - LEFT_PANEL);
  }

  private chartHeight(): number {
    return Math.max(1, this.container.clientHeight - HEADER_HEIGHT);
  }

  // ns -> px，相对于图表区域左边缘
  private nsToX(ns: number): number {
    const visRange = this.viewEnd - this.viewStart;
    return ((ns - this.viewStart) / visRange) * this.chartWidth();
  }

  // px -> ns，相对于图表区域左边缘
  private xToNs(px: number): number {
    const visRange = this.viewEnd - this.viewStart;
    return this.viewStart + (px / this.chartWidth()) * visRange;
  }

  // ── 事件 ──────────────────────────────────────────────────────────────────

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();

    if (e.shiftKey) {
      const CH = this.chartHeight();
      const totalH = this.groups.length * ROW_HEIGHT;
      const maxScrollY = Math.max(0, totalH - CH);

      this.scrollY = clamp(this.scrollY + e.deltaY, 0, maxScrollY);
      this.scheduleRender();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const mouseXInChart = e.clientX - rect.left - LEFT_PANEL;

    const pivotNs = this.xToNs(mouseXInChart);
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;

    let newStart = pivotNs - (pivotNs - this.viewStart) * factor;
    let newEnd = pivotNs + (this.viewEnd - pivotNs) * factor;

    // 最小可见范围：100ns
    const minRange = 100;
    if (newEnd - newStart < minRange) {
      const mid = (newStart + newEnd) / 2;
      newStart = mid - minRange / 2;
      newEnd = mid + minRange / 2;
    }

    // 最大可见范围：数据范围 3 倍
    const maxRange = (this.dataEnd - this.dataStart) * 3 || 1e12;
    if (newEnd - newStart > maxRange) {
      const mid = (newStart + newEnd) / 2;
      newStart = mid - maxRange / 2;
      newEnd = mid + maxRange / 2;
    }

    this.viewStart = newStart;
    this.viewEnd = newEnd;

    this.scheduleRender();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Alt') return;

    if (!this.measureMode) {
      this.measureMode = true;
      this.nextCursor = 'A';
      this.scheduleRender();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key !== 'Alt') return;

    this.measureMode = false;
    this.cursorA = null;
    this.cursorB = null;
    this.nextCursor = 'A';

    this.scheduleRender();
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const mouseXInChart = e.clientX - rect.left - LEFT_PANEL;

    // Alt 临时测量模式：
    // Alt + 左键点击，轮流设置 A/B 游标。
    // 这里用 e.altKey 兜底，避免 keydown 状态在某些情况下没同步。
    if (this.measureMode || e.altKey) {
      if (mouseXInChart < 0 || mouseXInChart > this.chartWidth()) {
        return;
      }

      this.measureMode = true;

      const ns = this.xToNs(mouseXInChart);

      if (this.nextCursor === 'A') {
        this.cursorA = ns;
        this.nextCursor = 'B';
      } else {
        this.cursorB = ns;
        this.nextCursor = 'A';
      }

      this.scheduleRender();
      return;
    }

    this.dragging = true;
    this.dragStartX = e.clientX;
    this.dragStartViewStart = this.viewStart;
    this.dragStartViewEnd = this.viewEnd;
    this.canvas.style.cursor = 'grabbing';
  };

  private onMouseMove = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();

    this.mouseX = e.clientX - rect.left - LEFT_PANEL;
    this.mouseY = e.clientY - rect.top - HEADER_HEIGHT;

    if (this.dragging) {
      const dx = e.clientX - this.dragStartX;
      const dNs =
        -(dx / this.chartWidth()) *
        (this.dragStartViewEnd - this.dragStartViewStart);

      this.viewStart = this.dragStartViewStart + dNs;
      this.viewEnd = this.dragStartViewEnd + dNs;
    }

    this.hoveredItem = this.hitTest(this.mouseX, this.mouseY);

    this.canvas.style.cursor = this.dragging
      ? 'grabbing'
      : this.measureMode || e.altKey
      ? 'crosshair'
      : this.hoveredItem
      ? 'pointer'
      : 'default';

    this.scheduleRender();
  };

  private onMouseUp = () => {
    this.dragging = false;
    this.canvas.style.cursor = this.hoveredItem ? 'pointer' : 'default';
  };

  private onDblClick = () => {
    this.fit();
  };

  private hitTest(mx: number, my: number): Item | null {
    if (mx < 0 || my < 0) return null;

    const groupIdx = Math.floor((my + this.scrollY) / ROW_HEIGHT);

    if (groupIdx < 0 || groupIdx >= this.groups.length) {
      return null;
    }

    const group = this.groups[groupIdx];
    const ns = this.xToNs(mx);

    for (const item of this.items) {
      if (item.groupId !== group.id) continue;

      // 对于很短但绘制成 1px 的 item，hitTest 稍微放宽
      const start = Math.min(item.startNs, item.endNs);
      const end = Math.max(item.startNs, item.endNs);

      if (ns >= start && ns <= end) {
        return item;
      }
    }

    return null;
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  private scheduleRender() {
    if (this.animFrame) return;

    this.animFrame = requestAnimationFrame(() => {
      this.animFrame = 0;
      this.render();
    });
  }

  private render() {
    const ctx = this.ctx;
    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
    const CW = this.chartWidth();
    const CH = this.chartHeight();

    ctx.clearRect(0, 0, W, H);

    // 背景
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, W, H);

    // 左侧 group 面板背景
    ctx.fillStyle = '#252526';
    ctx.fillRect(0, 0, LEFT_PANEL, H);

    // 左侧 header 背景
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(0, 0, LEFT_PANEL, HEADER_HEIGHT);

    // 坐标轴背景
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(LEFT_PANEL, 0, CW, HEADER_HEIGHT);

    // 左侧 header 标题
    ctx.fillStyle = '#dddddd';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Task', 8, HEADER_HEIGHT / 2);

    // 坐标轴
    this.renderAxis(ctx, CW, CH);

    // 行和 item
    this.renderRows(ctx, CW, CH);

    // 左侧分隔线
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LEFT_PANEL, 0);
    ctx.lineTo(LEFT_PANEL, H);
    ctx.stroke();

    // 坐标轴底部分隔线
    ctx.beginPath();
    ctx.moveTo(LEFT_PANEL, HEADER_HEIGHT);
    ctx.lineTo(W, HEADER_HEIGHT);
    ctx.stroke();

    // 鼠标游标线和顶部标签放在最后画，保证在最上层
    this.renderCrosshair(ctx, CW, CH);

    // Alt 测量游标
    this.renderMeasureCursors(ctx, CW, CH);

    // Tooltip 最后画
    if (this.hoveredItem) {
      this.renderTooltip(ctx, W, H);
    }
  }

  private renderAxis(ctx: CanvasRenderingContext2D, CW: number, CH: number) {
    const visibleNs = this.viewEnd - this.viewStart;
    const maxTicks = Math.max(4, Math.floor(CW / 100));
    const step = calcTickStep(visibleNs, maxTicks);

    const firstTick = Math.ceil(this.viewStart / step) * step;
    const origin = this.dataStart;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '11px monospace';

    for (let t = firstTick; t <= this.viewEnd; t += step) {
      const x = LEFT_PANEL + this.nsToX(t);

      if (x < LEFT_PANEL || x > LEFT_PANEL + CW) {
        continue;
      }

      // 内容区纵向网格线
      ctx.strokeStyle = '#383838';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT);
      ctx.lineTo(x, HEADER_HEIGHT + CH);
      ctx.stroke();

      // 顶部刻度线
      ctx.strokeStyle = '#888';
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT - 6);
      ctx.lineTo(x, HEADER_HEIGHT);
      ctx.stroke();

      // 坐标轴标签，相对 trace 起点
      const relNs = t - origin;
      const label = formatAxisNs(relNs, step);

      ctx.fillStyle = '#e0e0e0';
      ctx.fillText(label, x, HEADER_HEIGHT / 2);
    }
  }

  // 鼠标当前位置指示线
  private renderCrosshair(
    ctx: CanvasRenderingContext2D,
    CW: number,
    CH: number
  ) {
    if (this.mouseX < 0 || this.mouseX > CW) {
      return;
    }

    const mx = LEFT_PANEL + this.mouseX;
    const visibleNs = this.viewEnd - this.viewStart;
    const maxTicks = Math.max(4, Math.floor(CW / 100));
    const step = calcTickStep(visibleNs, maxTicks);
    const origin = this.dataStart;

    ctx.save();

    // 贯穿 header + chart 的竖线，最后画，确保显示在最上层
    ctx.strokeStyle = 'rgba(255,255,100,0.75)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(mx, 0);
    ctx.lineTo(mx, HEADER_HEIGHT + CH);
    ctx.stroke();
    ctx.setLineDash([]);

    const relNs = this.xToNs(this.mouseX) - origin;
    const label = formatAxisNs(relNs, step);
    const tw = ctx.measureText(label).width + 8;

    let lx = mx - tw / 2;
    lx = Math.max(LEFT_PANEL + 2, Math.min(lx, LEFT_PANEL + CW - tw - 2));

    ctx.fillStyle = 'rgba(50,50,0,0.92)';
    ctx.fillRect(lx, 2, tw, 18);

    ctx.fillStyle = '#ffffee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '11px monospace';
    ctx.fillText(label, lx + tw / 2, 11);

    ctx.restore();
  }

  private renderMeasureCursors(
    ctx: CanvasRenderingContext2D,
    CW: number,
    CH: number
  ) {
    if (!this.measureMode && this.cursorA === null && this.cursorB === null) {
      return;
    }

    const top = 0;
    const bottom = HEADER_HEIGHT + CH;
    const chartLeft = LEFT_PANEL;
    const chartRight = LEFT_PANEL + CW;
    const visibleNs = this.viewEnd - this.viewStart;
    const maxTicks = Math.max(4, Math.floor(CW / 100));
    const step = calcTickStep(visibleNs, maxTicks);
    const origin = this.dataStart;

    const cursorAX =
      this.cursorA === null ? null : chartLeft + this.nsToX(this.cursorA);
    const cursorBX =
      this.cursorB === null ? null : chartLeft + this.nsToX(this.cursorB);

    ctx.save();

    // 1. A/B 区间高亮
    if (
      this.cursorA !== null &&
      this.cursorB !== null &&
      cursorAX !== null &&
      cursorBX !== null
    ) {
      const x1 = Math.max(chartLeft, Math.min(cursorAX, cursorBX));
      const x2 = Math.min(chartRight, Math.max(cursorAX, cursorBX));

      if (x2 > chartLeft && x1 < chartRight && x2 > x1) {
        ctx.fillStyle = 'rgba(255, 220, 100, 0.10)';
        ctx.fillRect(x1, HEADER_HEIGHT, x2 - x1, CH);
      }
    }

    // 2. 画单个游标
    const drawCursor = (label: 'A' | 'B', ns: number | null, color: string) => {
      if (ns === null) return;

      const x = chartLeft + this.nsToX(ns);

      // 完全不在可视区，线不画；但标签也不画，避免误导
      if (x < chartLeft || x > chartRight) {
        return;
      }

      const relNs = ns - origin;
      const timeLabel = formatAxisNs(relNs, step);
      const text = `${label} ${timeLabel}`;

      // 竖线
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();

      // 顶部标签
      ctx.font = '11px monospace';
      const tw = ctx.measureText(text).width + 10;
      const th = 18;

      let lx = x - tw / 2;
      lx = Math.max(chartLeft + 2, Math.min(lx, chartRight - tw - 2));

      ctx.fillStyle = 'rgba(20,20,20,0.95)';
      ctx.beginPath();
      ctx.roundRect(lx, 20, tw, th, 4);
      ctx.fill();

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, lx + tw / 2, 20 + th / 2);
    };

    drawCursor('A', this.cursorA, '#ffd54f');
    drawCursor('B', this.cursorB, '#4fc3f7');

    // 3. 顶部测量提示 / 差值
    let infoText = '';

    if (this.cursorA !== null && this.cursorB !== null) {
      const delta = Math.abs(this.cursorB - this.cursorA);
      infoText = `Δ ${formatDurationNs(delta)}`;
    } else if (this.measureMode) {
      infoText =
        this.nextCursor === 'A'
          ? 'Measure: click to set A'
          : 'Measure: click to set B';
    }

    if (infoText) {
      ctx.font = 'bold 12px monospace';
      const tw = ctx.measureText(infoText).width + 14;
      const th = 20;

      let x: number;

      if (
        this.cursorA !== null &&
        this.cursorB !== null &&
        cursorAX !== null &&
        cursorBX !== null
      ) {
        x = (cursorAX + cursorBX) / 2 - tw / 2;
      } else {
        x = chartRight - tw - 8;
      }

      x = Math.max(chartLeft + 4, Math.min(x, chartRight - tw - 4));

      const y = 2;

      ctx.fillStyle = 'rgba(50,40,10,0.95)';
      ctx.beginPath();
      ctx.roundRect(x, y, tw, th, 4);
      ctx.fill();

      ctx.strokeStyle = '#ffdf80';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#fff4c2';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(infoText, x + tw / 2, y + th / 2);
    }

    ctx.restore();
  }

  private renderRows(ctx: CanvasRenderingContext2D, CW: number, CH: number) {
    const totalRows = this.groups.length;

    // 先限制 scrollY
    const totalH = totalRows * ROW_HEIGHT;
    const maxScrollY = Math.max(0, totalH - CH);
    this.scrollY = clamp(this.scrollY, 0, maxScrollY);

    // ── 1. 绘制左侧 group 面板和行背景，不做右侧图表 clip ──
    for (let i = 0; i < totalRows; i++) {
      const group = this.groups[i];
      const rowTop = HEADER_HEIGHT + i * ROW_HEIGHT - this.scrollY;

      if (rowTop + ROW_HEIGHT < HEADER_HEIGHT) continue;
      if (rowTop > HEADER_HEIGHT + CH) break;

      // 左侧标签背景
      ctx.fillStyle = '#252526';
      ctx.fillRect(0, rowTop, LEFT_PANEL, ROW_HEIGHT);

      // 左侧标签文字
      ctx.font =
        group.indent === 0 ? 'bold 12px sans-serif' : '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      // 一级线程用线程色，子任务用浅色；如果带 *，说明存在 incomplete
      const hasIncomplete = group.label.endsWith(' *');
      ctx.fillStyle =
        group.indent === 0
          ? hasIncomplete
            ? '#ffcc66'
            : lighten(group.color)
          : hasIncomplete
          ? '#ffcc66'
          : '#dddddd';

      const labelX = 8 + group.indent;
      const labelY = rowTop + ROW_HEIGHT / 2;

      ctx.fillText(group.label, labelX, labelY, LEFT_PANEL - 16 - group.indent);

      // 左侧行分隔线
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, rowTop + ROW_HEIGHT);
      ctx.lineTo(LEFT_PANEL, rowTop + ROW_HEIGHT);
      ctx.stroke();
    }

    // ── 2. 绘制右侧图表区域行背景和 items，只裁剪右侧 ──
    ctx.save();
    ctx.beginPath();
    ctx.rect(LEFT_PANEL, HEADER_HEIGHT, CW, CH);
    ctx.clip();

    for (let i = 0; i < totalRows; i++) {
      const group = this.groups[i];
      const rowTop = HEADER_HEIGHT + i * ROW_HEIGHT - this.scrollY;

      if (rowTop + ROW_HEIGHT < HEADER_HEIGHT) continue;
      if (rowTop > HEADER_HEIGHT + CH) break;

      // 右侧行背景
      ctx.fillStyle = i % 2 === 0 ? '#1e1e1e' : '#232323';
      ctx.fillRect(LEFT_PANEL, rowTop, CW, ROW_HEIGHT);

      // 右侧行分隔线
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(LEFT_PANEL, rowTop + ROW_HEIGHT);
      ctx.lineTo(LEFT_PANEL + CW, rowTop + ROW_HEIGHT);
      ctx.stroke();

      // 该行 items
      for (const item of this.items) {
        if (item.groupId !== group.id) continue;

        const x1Raw = LEFT_PANEL + this.nsToX(item.startNs);
        const x2Raw = LEFT_PANEL + this.nsToX(item.endNs);

        const x1 = Math.min(x1Raw, x2Raw);
        const x2 = Math.max(x1Raw, x2Raw);

        if (x2 < LEFT_PANEL || x1 > LEFT_PANEL + CW) {
          continue;
        }

        const visibleX = Math.max(x1, LEFT_PANEL);
        const visibleRight = Math.min(x2, LEFT_PANEL + CW);
        const itemW = Math.max(MIN_ITEM_WIDTH, visibleRight - visibleX);
        const itemH = ROW_HEIGHT - 6;
        const itemY = rowTop + 3;

        const isHovered = this.hoveredItem?.id === item.id;
        const isIncomplete = !!item.incomplete;

        ctx.fillStyle = isIncomplete
          ? isHovered
            ? '#ffcc66'
            : 'rgba(255, 170, 60, 0.82)'
          : isHovered
          ? lighten(item.color)
          : item.color;

        ctx.beginPath();
        ctx.roundRect(visibleX, itemY, itemW, itemH, 3);
        ctx.fill();

        ctx.strokeStyle = isIncomplete
          ? '#ffcc66'
          : isHovered
          ? '#ffffff'
          : 'rgba(0,0,0,0.3)';
        ctx.lineWidth = isIncomplete ? 1.6 : isHovered ? 1.5 : 0.5;
        ctx.stroke();

        // missing END 时在右边画个小尖头，提示“未结束”
        if (item.missingEnd && itemW >= 8) {
          const right = visibleX + itemW;

          ctx.save();
          ctx.strokeStyle = '#fff2a8';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(right - 6, itemY + 4);
          ctx.lineTo(right - 2, itemY + itemH / 2);
          ctx.lineTo(right - 6, itemY + itemH - 4);
          ctx.stroke();
          ctx.restore();
        }

        // item 标签，只在足够宽时绘制
        if (itemW > 30) {
          ctx.save();

          ctx.beginPath();
          ctx.rect(visibleX, itemY, itemW, itemH);
          ctx.clip();

          ctx.fillStyle = '#ffffff';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';

          ctx.fillText(item.label, visibleX + 4, itemY + itemH / 2);

          ctx.restore();
        }
      }
    }

    ctx.restore();

    // ── 3. 垂直滚动条 ──
    if (totalH > CH) {
      const barH = Math.max(30, (CH / totalH) * CH);
      const barY = HEADER_HEIGHT + (this.scrollY / maxScrollY) * (CH - barH);

      ctx.fillStyle = 'rgba(120,120,120,0.5)';
      ctx.beginPath();
      ctx.roundRect(LEFT_PANEL + CW - 6, barY, 4, barH, 2);
      ctx.fill();
    }
  }

  private renderTooltip(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const item = this.hoveredItem;
    if (!item) return;

    const lines = item.tooltip.split('\n');
    const padding = 8;
    const lineH = 18;
    const tipW = 130;
    const tipH = lines.length * lineH + padding * 2;

    let tx = LEFT_PANEL + this.mouseX + 16;
    let ty = HEADER_HEIGHT + this.mouseY + 8;

    if (tx + tipW > W) {
      tx = LEFT_PANEL + this.mouseX - tipW - 8;
    }

    if (ty + tipH > H) {
      ty = H - tipH - 4;
    }

    tx = Math.max(LEFT_PANEL + 2, tx);
    ty = Math.max(HEADER_HEIGHT + 2, ty);

    // tooltip 背景
    ctx.fillStyle = 'rgba(20,20,20,0.54)';
    ctx.beginPath();
    ctx.roundRect(tx, ty, tipW, tipH, 4);
    ctx.fill();

    ctx.strokeStyle = item.missingEnd ? '#ffcc66' : '#666';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    lines.forEach((line, idx) => {
      const x = tx + padding;
      const y = ty + padding + idx * lineH;

      // 第一行任务名加粗
      if (idx === 0) {
        ctx.font = 'bold 12px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(line, x, y);
        return;
      }

      // Status 高亮
      const statusMatch = line.match(/^(Status:\s*)(.+)$/);
      if (statusMatch) {
        const prefix = statusMatch[1];
        const value = statusMatch[2];

        ctx.font = '11px monospace';
        ctx.fillStyle = '#aaaaaa';
        ctx.fillText(prefix, x, y);

        const prefixW = ctx.measureText(prefix).width;

        ctx.font = 'bold 11px monospace';
        ctx.fillStyle =
          value === 'Missing END'
            ? '#ffcc66'
            : value === 'Complete'
            ? '#81c784'
            : '#ef5350';
        ctx.fillText(value, x + prefixW, y);
        return;
      }

      // Duration: 的值高亮加粗
      const durationMatch = line.match(/^(Duration:\s*)(.+)$/);

      if (durationMatch) {
        const prefix = durationMatch[1];
        const value = durationMatch[2];

        ctx.font = '11px monospace';
        ctx.fillStyle = '#aaaaaa';
        ctx.fillText(prefix, x, y);

        const prefixW = ctx.measureText(prefix).width;

        ctx.font = 'bold 11px monospace';
        ctx.fillStyle = '#4fc3f7';
        ctx.fillText(value, x + prefixW, y);
        return;
      }

      ctx.font = '11px monospace';
      ctx.fillStyle = '#dddddd';
      ctx.fillText(line, x, y);
    });
  }

  destroy() {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = 0;
    }

    this.resizeObserver?.disconnect();

    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('dblclick', this.onDblClick);

    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);

    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);

    this.canvas.remove();
  }
}

function lighten(hex: string): string {
  const n = parseInt(hex.slice(1), 16);

  if (!Number.isFinite(n)) {
    return hex;
  }

  const r = Math.min(255, ((n >> 16) & 0xff) + 60);
  const g = Math.min(255, ((n >> 8) & 0xff) + 60);
  const b = Math.min(255, (n & 0xff) + 60);

  return `rgb(${r},${g},${b})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

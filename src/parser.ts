// 明确定义每个 start event 对应的 end event
const EVENT_PAIRS = new Map<number, number>([
  // MAIN lifecycle
  [301, 399],
  // RUN lifecycle
  [101, 199],
  // TRANS lifecycle
  [201, 299],
  // MAIN tasks
  [311, 312],
  [313, 314],
  [315, 316],
  [317, 318],
  [319, 320],
  [321, 322],
  // RUN tasks
  [111, 112],
  [113, 114],
  [115, 116],
  [117, 118],
  [119, 120],
  [121, 122],
  [123, 124],
  [125, 126],
  [127, 128],
  // TRANS tasks
  [211, 212],
  [213, 214],
  [215, 216],
  [217, 218],
  [219, 220],
]);

// end event -> start event 反查
const END_TO_START = new Map<number, number>();
for (const [start, end] of EVENT_PAIRS) {
  END_TO_START.set(end, start);
}

const START_EVENTS = new Set(EVENT_PAIRS.keys());

const EVENT_INFO = new Map<number, { thread: string; task: string }>([
  // MAIN lifecycle
  [301, { thread: 'MAIN', task: 'MAIN' }],
  [399, { thread: 'MAIN', task: 'MAIN' }],
  // RUN lifecycle
  [101, { thread: 'RUN', task: 'RUN' }],
  [199, { thread: 'RUN', task: 'RUN' }],
  // TRANS lifecycle
  [201, { thread: 'TRANS', task: 'TRANS' }],
  [299, { thread: 'TRANS', task: 'TRANS' }],
  // MAIN tasks
  [311, { thread: 'MAIN', task: 'MAIN.GetDiInf' }],
  [312, { thread: 'MAIN', task: 'MAIN.GetDiInf' }],
  [313, { thread: 'MAIN', task: 'MAIN.LAYER1' }],
  [314, { thread: 'MAIN', task: 'MAIN.LAYER1' }],
  [315, { thread: 'MAIN', task: 'MAIN.TcsID45' }],
  [316, { thread: 'MAIN', task: 'MAIN.TcsID45' }],
  [317, { thread: 'MAIN', task: 'MAIN.BzVhlDsip' }],
  [318, { thread: 'MAIN', task: 'MAIN.BzVhlDsip' }],
  [319, { thread: 'MAIN', task: 'MAIN.TcsSend' }],
  [320, { thread: 'MAIN', task: 'MAIN.TcsSend' }],
  [321, { thread: 'MAIN', task: 'MAIN.SetDoInf' }],
  [322, { thread: 'MAIN', task: 'MAIN.SetDoInf' }],
  // RUN tasks
  [111, { thread: 'RUN', task: 'RUN.GetDiInf' }],
  [112, { thread: 'RUN', task: 'RUN.GetDiInf' }],
  [113, { thread: 'RUN', task: 'RUN.QrRead' }],
  [114, { thread: 'RUN', task: 'RUN.QrRead' }],
  [115, { thread: 'RUN', task: 'RUN.NodeRenew' }],
  [116, { thread: 'RUN', task: 'RUN.NodeRenew' }],
  [117, { thread: 'RUN', task: 'RUN.E2801' }],
  [118, { thread: 'RUN', task: 'RUN.E2801' }],
  [119, { thread: 'RUN', task: 'RUN.SpeedCalc' }],
  [120, { thread: 'RUN', task: 'RUN.SpeedCalc' }],
  [121, { thread: 'RUN', task: 'RUN.SteerCtl' }],
  [122, { thread: 'RUN', task: 'RUN.SteerCtl' }],
  [123, { thread: 'RUN', task: 'RUN.Layer1' }],
  [124, { thread: 'RUN', task: 'RUN.Layer1' }],
  [125, { thread: 'RUN', task: 'RUN.lmx1' }],
  [126, { thread: 'RUN', task: 'RUN.lmx1' }],
  [127, { thread: 'RUN', task: 'RUN.SetDoInf' }],
  [128, { thread: 'RUN', task: 'RUN.SetDoInf' }],
  // TRANS tasks
  [211, { thread: 'TRANS', task: 'TRANS.GetDiInf' }],
  [212, { thread: 'TRANS', task: 'TRANS.GetDiInf' }],
  [213, { thread: 'TRANS', task: 'TRANS.LmxStatus' }],
  [214, { thread: 'TRANS', task: 'TRANS.LmxStatus' }],
  [215, { thread: 'TRANS', task: 'TRANS.Layer1' }],
  [216, { thread: 'TRANS', task: 'TRANS.Layer1' }],
  [217, { thread: 'TRANS', task: 'TRANS.lmx' }],
  [218, { thread: 'TRANS', task: 'TRANS.lmx' }],
  [219, { thread: 'TRANS', task: 'TRANS.SetDoInf' }],
  [220, { thread: 'TRANS', task: 'TRANS.SetDoInf' }],
]);

export interface TraceEntry {
  timestamp_ns: bigint;
  thread_id: number;
  event: number;
  thread: string;
  task: string;
}

export interface TraceSpan {
  id: string;
  thread: string;
  task: string;
  start_ns: bigint;
  end_ns: bigint;
  duration_us: number;
}

export function parseTrace(buffer: ArrayBuffer): TraceEntry[] {
  const view = new DataView(buffer);
  const entries: TraceEntry[] = [];
  const RECORD_SIZE = 16;

  for (
    let offset = 0;
    offset + RECORD_SIZE <= buffer.byteLength;
    offset += RECORD_SIZE
  ) {
    const ts_lo = view.getUint32(offset, true);
    const ts_hi = view.getUint32(offset + 4, true);
    const ts = (BigInt(ts_hi) << 32n) | BigInt(ts_lo);
    const tid = view.getUint32(offset + 8, true);
    const event = view.getUint16(offset + 12, true);

    if (event === 0) continue;

    const info = EVENT_INFO.get(event);
    if (!info) continue;

    entries.push({
      timestamp_ns: ts,
      thread_id: tid,
      event,
      thread: info.thread,
      task: info.task,
    });
  }

  entries.sort((a, b) =>
    a.timestamp_ns < b.timestamp_ns
      ? -1
      : a.timestamp_ns > b.timestamp_ns
      ? 1
      : 0
  );
  return entries;
}

export function buildSpans(entries: TraceEntry[]): TraceSpan[] {
  // key: `${thread_id}-${task}` -> start entry
  const pending = new Map<
    string,
    { event: number; ts: bigint; task: string; thread: string }
  >();
  const spans: TraceSpan[] = [];
  let spanId = 0;

  const base_ns = entries.length > 0 ? entries[0].timestamp_ns : 0n;

  for (const e of entries) {
    const key = `${e.thread_id}-${e.task}`;

    if (START_EVENTS.has(e.event)) {
      // 开始事件，记录到 pending
      pending.set(key, {
        event: e.event,
        ts: e.timestamp_ns,
        task: e.task,
        thread: e.thread,
      });
    } else {
      // 结束事件，查找对应的 start
      const expectedStart = END_TO_START.get(e.event);
      if (expectedStart === undefined) continue;

      const start = pending.get(key);
      if (!start || start.event !== expectedStart) continue;

      pending.delete(key);

      const duration_us = Number(e.timestamp_ns - start.ts) / 1000;
      spans.push({
        id: `span-${spanId++}`,
        thread: e.thread,
        task: start.task,
        start_ns: start.ts - base_ns,
        end_ns: e.timestamp_ns - base_ns,
        duration_us,
      });
    }
  }

  console.log('=== buildSpans Summary ===');
  console.log('Total spans:', spans.length);
  const byTask = new Map<string, number>();
  spans.forEach((s) => byTask.set(s.task, (byTask.get(s.task) || 0) + 1));
  byTask.forEach((count, task) => console.log(`  ${task}: ${count}`));

  return spans;
}

export function getTaskTree(): Map<string, string[]> {
  const tree = new Map<string, string[]>([
    [
      'MAIN',
      [
        'MAIN',
        'MAIN.GetDiInf',
        'MAIN.LAYER1',
        'MAIN.TcsID45',
        'MAIN.BzVhlDsip',
        'MAIN.TcsSend',
        'MAIN.SetDoInf',
      ],
    ],
    [
      'RUN',
      [
        'RUN',
        'RUN.GetDiInf',
        'RUN.QrRead',
        'RUN.NodeRenew',
        'RUN.E2801',
        'RUN.SpeedCalc',
        'RUN.SteerCtl',
        'RUN.Layer1',
        'RUN.lmx1',
        'RUN.SetDoInf',
      ],
    ],
    [
      'TRANS',
      [
        'TRANS',
        'TRANS.GetDiInf',
        'TRANS.LmxStatus',
        'TRANS.Layer1',
        'TRANS.lmx',
        'TRANS.SetDoInf',
      ],
    ],
  ]);
  return tree;
}

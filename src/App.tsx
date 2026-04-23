import React, { useState, useRef, useEffect, useCallback } from 'react';
import { parseTrace, buildSpans, getTaskTree } from './parser';
import type { TraceSpan } from './parser';
import { TraceTimeline } from './timeline';
import './App.css';

const DEFAULT_VISIBLE = new Set(['MAIN', 'RUN', 'TRANS']);

export default function App() {
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [visibleTasks, setVisibleTasks] = useState<Set<string>>(new Set());
  const needFitRef = useRef(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<TraceTimeline | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (timelineRef.current && !tlRef.current) {
      tlRef.current = new TraceTimeline();
      tlRef.current.init(timelineRef.current);
    }
    return () => {
      tlRef.current?.destroy();
      tlRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!tlRef.current) return;
    const shouldFit = needFitRef.current;
    needFitRef.current = false;
    tlRef.current.update(spans, visibleTasks, shouldFit);
  }, [spans, visibleTasks]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const entries = parseTrace(buffer);
    const newSpans = buildSpans(entries);
    setSpans(newSpans);
    needFitRef.current = true;
    setVisibleTasks(new Set(DEFAULT_VISIBLE));
  };

  const handleTaskToggle = useCallback((task: string) => {
    setVisibleTasks((prev) => {
      const next = new Set(prev);
      next.has(task) ? next.delete(task) : next.add(task);
      return next;
    });
  }, []);

  const handleThreadToggle = useCallback((thread: string, tasks: string[]) => {
    setVisibleTasks((prev) => {
      const next = new Set(prev);
      const allSelected = tasks.every((t) => next.has(t));
      allSelected
        ? tasks.forEach((t) => next.delete(t))
        : tasks.forEach((t) => next.add(t));
      return next;
    });
  }, []);

  const taskTree = getTaskTree();

  return (
    <div className={`app ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="sidebar">
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed((v) => !v)}
          title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>

        <div className="sidebar-content">
          <h3>Trace File</h3>
          <input type="file" accept=".bin" onChange={handleFileChange} />

          <p style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            滚轮缩放 · 拖动平移 · 双击重置
            <br />
            Shift+滚轮 垂直滚动
          </p>

          <h3>Tasks</h3>

          {spans.length === 0 ? (
            <p style={{ fontSize: 12, color: '#666' }}>Load a trace file</p>
          ) : (
            <div className="task-tree">
              {Array.from(taskTree.entries()).map(([thread, tasks]) => {
                const allSelected = tasks.every((t) => visibleTasks.has(t));
                const someSelected = tasks.some((t) => visibleTasks.has(t));

                return (
                  <div key={thread} className="thread-group">
                    <label>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) {
                            el.indeterminate = someSelected && !allSelected;
                          }
                        }}
                        onChange={() => handleThreadToggle(thread, tasks)}
                      />
                      <strong> {thread}</strong>
                    </label>

                    <div className="task-list">
                      {tasks.map((task) => {
                        const isLifecycle = task === thread;
                        const label = isLifecycle ? thread : task.split('.')[1];

                        return (
                          <label
                            key={task}
                            style={{
                              marginLeft: isLifecycle ? 0 : 20,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={visibleTasks.has(task)}
                              onChange={() => handleTaskToggle(task)}
                            />
                            {isLifecycle ? <strong>{label}</strong> : label}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="main" style={{ position: 'relative' }}>
        <div ref={timelineRef} className="timeline-container" />

        {spans.length === 0 && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%,-50%)',
              color: '#999',
              fontSize: 14,
              pointerEvents: 'none',
            }}
          >
            No data loaded
          </div>
        )}

        {spans.length > 0 && visibleTasks.size === 0 && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%,-50%)',
              color: '#999',
              fontSize: 14,
              pointerEvents: 'none',
            }}
          >
            Select tasks from the sidebar
          </div>
        )}
      </div>
    </div>
  );
}

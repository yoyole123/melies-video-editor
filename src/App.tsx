import { Timeline } from '@xzdarcy/react-timeline-editor';
import type { TimelineState } from '@xzdarcy/react-timeline-editor';
import { Switch } from 'antd';
import { useRef, useState } from 'react';
import { CustomRender0, CustomRender1 } from './custom';
import './index.less';
import { mockData, mockEffect, scale, scaleWidth, startLeft } from './mock';
import type { CustomTimelineAction, CusTomTimelineRow } from './mock';
import { FOOTAGE_BIN } from './footageBin';
import TimelinePlayer from './player';
import videoControl from './videoControl';

const defaultEditorData = structuredClone(mockData);

const TimelineEditor = () => {
  const [data, setData] = useState(defaultEditorData);
  const timelineState = useRef<TimelineState | null>(null);
  const playerPanel = useRef<HTMLDivElement | null>(null);
  const timelineWrapRef = useRef<HTMLDivElement | null>(null);
  const autoScrollWhenPlay = useRef<boolean>(true);

  const uid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}`);

  const insertActionAtTime = (item: { kind: 'video' | 'audio'; src: string; name: string; defaultDuration?: number }, at: number) => {
    const duration = item.defaultDuration ?? 10;
    const start = Math.max(0, at);
    const end = start + duration;

    setData((prev) => {
      const next = structuredClone(prev) as CusTomTimelineRow[];
      // Ensure we have at least 2 rows: [videoRow, audioRow]
      while (next.length < 2) next.push({ id: `${next.length}`, actions: [] } as unknown as CusTomTimelineRow);
      const rowIndex = item.kind === 'video' ? 0 : 1;
      next[rowIndex].actions = [
        ...(next[rowIndex].actions ?? []),
        {
          id: `${item.kind}-${uid()}`,
          start,
          end,
          effectId: item.kind === 'video' ? 'effect1' : 'effect0',
          data: { src: item.src, name: item.name },
        } as CustomTimelineAction,
      ];
      return next;
    });
  };

  const getTimelineScrollLeft = () => {
    const root = timelineWrapRef.current;
    if (!root) return 0;
    const grid = root.querySelector('.timeline-editor-edit-area .ReactVirtualized__Grid') as HTMLElement | null;
    return (grid as any)?.scrollLeft ?? 0;
  };

  const dropTimeFromEvent = (e: React.DragEvent) => {
    const root = timelineWrapRef.current;
    if (!root) return 0;
    const editArea = root.querySelector('.timeline-editor-edit-area') as HTMLElement | null;
    const rect = (editArea ?? root).getBoundingClientRect();
    const position = e.clientX - rect.x;
    const left = position + getTimelineScrollLeft();
    const time = ((left - startLeft) * scale) / scaleWidth;
    return Math.max(0, time);
  };

  const handleDropOnTimeline = (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/x-footage-item');
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as { kind: 'video' | 'audio'; src: string; name: string; defaultDuration?: number };
      const at = dropTimeFromEvent(e);
      insertActionAtTime(item, at);
    } catch {
      // ignore
    }
  };

  return (
    <div className="timeline-editor-engine">
      <div className="player-config">
        <div className="footage-bin">
          {FOOTAGE_BIN.map((item) => (
            <div
              key={item.id}
              className="footage-card"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('application/x-footage-item', JSON.stringify(item));
              }}
            >
              <div className="footage-name">{item.name}</div>
              {item.kind === 'video' ? (
                <video className="footage-preview" src={item.src} muted preload="metadata" />
              ) : (
                <audio className="footage-audio" src={item.src} controls preload="metadata" />
              )}
              <div className="footage-kind">Drag into timeline</div>
            </div>
          ))}
        </div>
      </div>
      <div className="player-panel" ref={playerPanel}>
        <video
          className="player-video"
          src={data?.[0]?.actions?.[0]?.data?.src}
          preload="auto"
          playsInline
          controls={false}
          disablePictureInPicture
          disableRemotePlayback
          controlsList="nodownload noplaybackrate noremoteplayback"
          tabIndex={-1}
          onContextMenu={(e) => e.preventDefault()}
          ref={(el) => videoControl.attach(el)}
        />
      </div>
      <TimelinePlayer timelineState={timelineState} autoScrollWhenPlay={autoScrollWhenPlay} />
      <div
        ref={timelineWrapRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDropOnTimeline}
      >
        <Timeline
          scale={scale}
          scaleWidth={scaleWidth}
          startLeft={startLeft}
          autoScroll={true}
          ref={timelineState}
          editorData={data}
          effects={mockEffect}
          onChange={(data) => {
            setData(data as CusTomTimelineRow[]);
          }}
          getActionRender={(action, row) => {
            if (action.effectId === 'effect0') {
              return <CustomRender0 action={action as CustomTimelineAction} row={row as CusTomTimelineRow} />;
            } else if (action.effectId === 'effect1') {
              return <CustomRender1 action={action as CustomTimelineAction} row={row as CusTomTimelineRow} />;
            }
          }}
        />
      </div>
    </div>
  );
};
export default TimelineEditor;
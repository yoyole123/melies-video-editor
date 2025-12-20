import { Timeline } from '@xzdarcy/react-timeline-editor';
import type { TimelineState } from '@xzdarcy/react-timeline-editor';
import { Switch } from 'antd';
import { useRef, useState } from 'react';
import { CustomRender0, CustomRender1 } from './custom';
import './index.less';
import { mockData, mockEffect, scale, scaleWidth, startLeft } from './mock';
import type { CustomTimelineAction, CusTomTimelineRow } from './mock';
import TimelinePlayer from './player';
import videoControl from './videoControl';

const defaultEditorData = structuredClone(mockData);

const TimelineEditor = () => {
  const [data, setData] = useState(defaultEditorData);
  const timelineState = useRef<TimelineState | null>(null);
  const playerPanel = useRef<HTMLDivElement | null>(null);
  const autoScrollWhenPlay = useRef<boolean>(true);

  return (
    <div className="timeline-editor-engine">
      <div className="player-config">
        <Switch
          checkedChildren="开启运行时自动滚动"
          unCheckedChildren="禁用运行时自动滚动"
          defaultChecked={autoScrollWhenPlay.current}
          onChange={(e) => (autoScrollWhenPlay.current = e)}
          style={{ marginBottom: 20 }}
        />
      </div>
      <div className="player-panel" ref={playerPanel}>
        <video
          className="player-video"
          src={mockData[0].actions[0].data.src}
          controls
          preload="auto"
          ref={(el) => videoControl.attach(el)}
        />
      </div>
      <TimelinePlayer timelineState={timelineState} autoScrollWhenPlay={autoScrollWhenPlay} />
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
  );
};
export default TimelineEditor;
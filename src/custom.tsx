import type { FC } from 'react';
import type { CustomTimelineAction, CusTomTimelineRow } from './mock';

export const CustomRender0: FC<{ action: CustomTimelineAction; row: CusTomTimelineRow }> = ({ action, row }) => {
  return (
    <div className={'effect0'} data-action-id={action.id} data-row-id={row.id}>
      <div className={`effect0-text`}>{`Audio: ${action.data.name}`}</div>
    </div>
  );
};

export const CustomRender1: FC<{ action: CustomTimelineAction; row: CusTomTimelineRow }> = ({ action, row }) => {
  return (
    <div className={'effect1'} data-action-id={action.id} data-row-id={row.id}>
      <div className={`effect1-text`}>{`Video: ${action.data.name}`}</div>
    </div>
  );
};
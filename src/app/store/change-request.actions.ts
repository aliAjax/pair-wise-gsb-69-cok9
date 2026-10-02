import { createActionGroup, emptyProps, props } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  DeviationRecord,
  ExecutionControl,
} from '../models/change-request.model';

export const ChangeRequestActions = createActionGroup({
  source: 'Change Request',
  events: {
    'Load Changes': emptyProps(),
    'Load Changes Success': props<{ changes: ChangeRequest[] }>(),
    'Load Changes Failure': props<{ error: string }>(),
    'Create Change': props<{ change: ChangeRequest }>(),
    /** baseVersion 为页面打开/开始编辑时读到的版本，用于乐观并发校验。 */
    'Update Change': props<{ change: ChangeRequest; baseVersion: number }>(),
    'Update Change Rejected': props<{ id: string; reason: string; serverChange: ChangeRequest }>(),
    'Delete Draft': props<{ id: string }>(),
    'Submit For Review': props<{ id: string }>(),
    'Approve Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Reject Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Start Execution': props<{ id: string }>(),
    'Control Execution': props<{ id: string; control: ExecutionControl; note: string }>(),
    'Toggle Step': props<{ id: string; stepId: string }>(),
    'Record Deviation': props<{ id: string; deviation: DeviationRecord }>(),
    'Complete Execution': props<{ id: string; result: 'completed' | 'rolled_back'; note: string }>(),
    /** localStorage 持久化失败，回滚到最近一次有效持久化版本。 */
    'Persist Failure': props<{ error: string; lastPersisted: ChangeRequest[] }>(),
    'Persist Success': props<{ changes: ChangeRequest[] }>(),
    /** 其他标签页写入 localStorage 后同步到本标签页。 */
    'Storage Synced': props<{ changes: ChangeRequest[] }>(),
    'Clear Save Error': props<{ id: string }>(),
  },
});

import { createActionGroup, emptyProps, props } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  DeviationDecision,
} from '../models/change-request.model';

export interface SaveConflictInfo {
  id: string;
  reason: 'stale' | 'frozen';
  currentVersion: number;
  attemptedVersion?: number;
}

export const ChangeRequestActions = createActionGroup({
  source: 'Change Request',
  events: {
    'Load Changes': emptyProps(),
    'Load Changes Success': props<{ changes: ChangeRequest[] }>(),
    'Load Changes Failure': props<{ error: string }>(),
    'Create Change': props<{ change: ChangeRequest }>(),
    /** 保存携带基线版本；冻结版本不可覆盖，旧版本号一律拒绝。 */
    'Update Change': props<{ change: ChangeRequest; baseVersion: number }>(),
    'Delete Draft': props<{ id: string }>(),
    'Submit For Review': props<{ id: string }>(),
    'Approve Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Reject Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    /** 开始执行：冻结方案和会签快照，作为唯一有效执行版本。 */
    'Start Execution': props<{ id: string }>(),
    'Toggle Step': props<{ id: string; stepId: string }>(),
    /**
     * 执行中记录处置决定（继续/暂停/继续执行/回滚）。
     * pause 与 rollback 会使共享资源上尚未开始的关联变更审批失效。
     */
    'Record Execution Decision': props<{
      id: string;
      owner: string;
      description: string;
      decision: DeviationDecision;
      eventId: string;
    }>(),
    'Complete Execution': props<{ id: string; result: 'completed' | 'rolled_back'; note: string }>(),
    /** 持久化时与其他窗口对账：旧页面不得覆盖冻结/更新版本。 */
    'External Changes Synced': props<{ changes: ChangeRequest[]; conflict?: SaveConflictInfo }>(),
    'Persist Failure': props<{ error: string }>(),
    'Dismiss Save Conflict': props<{ id: string }>(),
  },
});

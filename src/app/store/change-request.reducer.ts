import { createReducer, on } from '@ngrx/store';
import {
  ApprovalRecord,
  ChangeRequest,
  DeviationDecision,
  applyCascadeInvalidation,
  activeApprovals,
  buildExecutionSnapshot,
  createAudit,
  isExecutionFrozen,
  nextPendingStage,
  normalizeChange,
} from '../models/change-request.model';
import { ChangeRequestActions, SaveConflictInfo } from './change-request.actions';

export interface ChangeRequestState {
  changes: ChangeRequest[];
  loading: boolean;
  error: string | null;
  /** 保存失败（版本过期或覆盖冻结版本）的对账提示，按变更 ID 去重。 */
  saveConflicts: SaveConflictInfo[];
}

export const initialChangeRequestState: ChangeRequestState = {
  changes: [],
  loading: false,
  error: null,
  saveConflicts: [],
};

function touch(change: ChangeRequest): ChangeRequest {
  return { ...change, version: (change.version ?? 1) + 1, updatedAt: new Date().toISOString() };
}

function clearConflict(conflicts: SaveConflictInfo[], id: string): SaveConflictInfo[] {
  return conflicts.filter((conflict) => conflict.id !== id);
}

function addConflict(
  conflicts: SaveConflictInfo[],
  conflict: SaveConflictInfo,
): SaveConflictInfo[] {
  return [...conflicts.filter((item) => item.id !== conflict.id), conflict];
}

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { changes }) => ({
    ...state,
    changes: changes.map(normalizeChange),
    loading: false,
  })),
  on(ChangeRequestActions.loadChangesFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(ChangeRequestActions.createChange, (state, { change }) => ({
    ...state,
    changes: [
      {
        ...change,
        version: 1,
        executionSnapshot: undefined,
        audit: [createAudit('创建草稿', `创建变更 ${change.id}`), ...change.audit],
      },
      ...state.changes,
    ],
  })),
  on(ChangeRequestActions.updateChange, (state, { change, baseVersion }) => ({
    ...state,
    changes: state.changes.map((item) => {
      if (item.id !== change.id) {
        return item;
      }
      // 执行版本已冻结：任何旧页面的保存都不得覆盖。
      if (isExecutionFrozen(item)) {
        return item;
      }
      // 乐观锁：基线版本与当前执行版本不一致时拒绝。
      if (baseVersion !== (item.version ?? 1)) {
        return item;
      }
      return touch({
        ...change,
        version: item.version,
        executionSnapshot: undefined,
        audit: [
          createAudit('保存变更方案', '更新资源、步骤或窗口信息'),
          ...change.audit,
        ],
      });
    }),
    saveConflicts: (() => {
      const current = state.changes.find((item) => item.id === change.id);
      if (!current) {
        return state.saveConflicts;
      }
      if (isExecutionFrozen(current)) {
        return addConflict(state.saveConflicts, {
          id: change.id,
          reason: 'frozen',
          currentVersion: current.version,
          attemptedVersion: baseVersion,
        });
      }
      if (baseVersion !== (current.version ?? 1)) {
        return addConflict(state.saveConflicts, {
          id: change.id,
          reason: 'stale',
          currentVersion: current.version,
          attemptedVersion: baseVersion,
        });
      }
      return clearConflict(state.saveConflicts, change.id);
    })(),
  })),
  on(ChangeRequestActions.deleteDraft, (state, { id }) => ({
    ...state,
    changes: state.changes.filter((change) => change.id !== id || change.status !== 'draft'),
  })),
  on(ChangeRequestActions.submitForReview, (state, { id }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || !['draft', 'rejected'].includes(change.status)) {
        return change;
      }
      const activeRound = Math.max(...change.approvals.map((approval) => approval.round || 1), 1);
      const approvals = change.approvals.map((approval) =>
        (approval.round || 1) === activeRound && approval.state !== 'frozen'
          ? { ...approval, state: 'pending' as const, approver: undefined, decidedAt: undefined, comment: undefined }
          : approval,
      );
      return touch({
        ...change,
        status: 'submitted',
        approvals,
        audit: [createAudit('提交审批', '方案冻结后进入网络、系统、安全、业务顺序会签'), ...change.audit],
      });
    }),
  })),
  on(ChangeRequestActions.approveStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (
        change.id !== id ||
        !['submitted', 'rejected'].includes(change.status) ||
        nextPendingStage(change) !== stage
      ) {
        return change;
      }

      const activeRound = Math.max(...change.approvals.map((approval) => approval.round || 1), 1);
      const approvals = change.approvals.map((approval) =>
        (approval.round || 1) === activeRound && approval.stage === stage
          ? {
              ...approval,
              state: 'approved' as const,
              approver,
              comment,
              decidedAt: new Date().toISOString(),
            }
          : approval,
      );
      const allApproved = activeApprovals({ ...change, approvals }).every(
        (approval) => approval.state === 'approved',
      );

      return touch({
        ...change,
        status: allApproved ? 'approved' : 'submitted',
        approvals,
        audit: [
          createAudit('阶段会签', `第 ${activeRound} 轮 ${stage} 已由 ${approver} 批准：${comment}`),
          ...change.audit,
        ],
      });
    }),
  })),
  on(ChangeRequestActions.rejectStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (
        change.id !== id ||
        !['submitted', 'rejected'].includes(change.status) ||
        nextPendingStage(change) !== stage
      ) {
        return change;
      }

      const activeRound = Math.max(...change.approvals.map((approval) => approval.round || 1), 1);
      const approvals = change.approvals.map((approval) =>
        (approval.round || 1) === activeRound && approval.stage === stage
          ? {
              ...approval,
              state: 'rejected' as const,
              approver,
              comment,
              decidedAt: new Date().toISOString(),
            }
          : approval,
      );

      return touch({
        ...change,
        status: 'rejected',
        approvals,
        audit: [
          createAudit('审批退回', `第 ${activeRound} 轮 ${stage} 由 ${approver} 退回：${comment}`),
          ...change.audit,
        ],
      });
    }),
  })),
  on(ChangeRequestActions.startExecution, (state, { id }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || change.status !== 'approved' || isExecutionFrozen(change)) {
        return change;
      }
      const frozenAt = new Date().toISOString();
      const snapshot = buildExecutionSnapshot(change, frozenAt);
      const approvals: ApprovalRecord[] = change.approvals.map((approval) =>
        approval.state === 'frozen'
          ? approval
          : {
              ...approval,
              state: snapshot.approvals.some(
                (frozen) => frozen.stage === approval.stage && frozen.round === approval.round,
              )
                ? ('frozen' as const)
                : approval.state,
            },
      );
      return touch({
        ...change,
        status: 'executing',
        executionSnapshot: snapshot,
        approvals,
        audit: [
          createAudit('开始执行', '执行开始，方案和会签已冻结为执行版本（唯一有效版本）', '当前用户', frozenAt),
          ...change.audit,
        ],
      });
    }),
  })),
  on(ChangeRequestActions.toggleStep, (state, { id, stepId }) => ({
    ...state,
    changes: state.changes.map((change) =>
      // 暂停期间不允许勾选步骤。
      change.id === id && change.status === 'executing'
        ? touch({
            ...change,
            steps: change.steps.map((step) =>
              step.id === stepId
                ? {
                    ...step,
                    completed: !step.completed,
                    completedAt: step.completed ? undefined : new Date().toISOString(),
                  }
                : step,
            ),
          })
        : change,
    ),
  })),
  on(
    ChangeRequestActions.recordExecutionDecision,
    (state, { id, owner, description, decision, eventId }) => {
      const target = state.changes.find((change) => change.id === id);
      if (!target || !['executing', 'paused'].includes(target.status)) {
        return state;
      }
      // 执行中可继续/暂停/回滚；暂停后只能继续或回滚。
      const allowed: Record<'executing' | 'paused', DeviationDecision[]> = {
        executing: ['continue', 'pause', 'rollback'],
        paused: ['resume', 'rollback'],
      };
      if (!allowed[target.status as 'executing' | 'paused'].includes(decision)) {
        return state;
      }

      const at = new Date().toISOString();
      const reason =
        decision === 'rollback' ? '关联变更执行回滚' : '关联变更执行暂停';
      const cascaded =
        decision === 'pause' || decision === 'rollback'
          ? applyCascadeInvalidation(state.changes, {
              sourceId: id,
              eventId,
              reason,
              at,
              actor: owner,
            })
          : { changes: state.changes, affected: [] };

      const actionLabel =
        decision === 'pause'
          ? '暂停执行'
          : decision === 'resume'
            ? '继续执行'
            : decision === 'rollback'
              ? '执行回滚'
              : '记录执行偏离';
      const nextStatus =
        decision === 'pause'
          ? ('paused' as const)
          : decision === 'resume'
            ? ('executing' as const)
            : decision === 'rollback'
              ? ('rolled_back' as const)
              : target.status;

      const changes = cascaded.changes.map((change) =>
        change.id === id
          ? touch({
              ...change,
              status: nextStatus,
              deviations: [
                {
                  id: `dev-${eventId}`,
                  recordedAt: at,
                  owner,
                  description,
                  decision,
                  eventId,
                },
                ...change.deviations,
              ],
              audit: [createAudit(actionLabel, `${owner}：${description}`, owner, at), ...change.audit],
            })
          : change,
      );

      return { ...state, changes };
    },
  ),
  on(ChangeRequestActions.completeExecution, (state, { id, result, note }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id && ['executing', 'paused'].includes(change.status)
        ? touch({
            ...change,
            status: result,
            audit: [
              createAudit(result === 'completed' ? '执行完成' : '执行回滚', note),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.externalChangesSynced, (state, { changes, conflict }) => ({
    ...state,
    changes: changes.map(normalizeChange),
    saveConflicts: conflict
      ? addConflict(state.saveConflicts, conflict)
      : state.saveConflicts,
  })),
  on(ChangeRequestActions.persistFailure, (state, { error }) => ({ ...state, error })),
  on(ChangeRequestActions.dismissSaveConflict, (state, { id }) => ({
    ...state,
    saveConflicts: clearConflict(state.saveConflicts, id),
  })),
);

import { createReducer, on } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  APPROVAL_ORDER,
  InvalidationRecord,
  createAudit,
  createExecutionEvent,
  buildExecutionSnapshot,
  isExecutionPaused,
  normalizeChange,
  sharesResource,
  sharedResourceNames,
} from '../models/change-request.model';
import { ChangeRequestActions } from './change-request.actions';

export interface ChangeRequestState {
  changes: ChangeRequest[];
  loading: boolean;
  error: string | null;
  /** id -> 最近一次保存被拒绝的原因（并发冲突 / 冻结版本）。 */
  saveErrors: Record<string, string>;
  /** 最近一次确认已写入 localStorage 的全量数据，用于保存失败时回滚。 */
  lastPersisted: ChangeRequest[] | null;
  lastSaveError: string | null;
}

export const initialChangeRequestState: ChangeRequestState = {
  changes: [],
  loading: false,
  error: null,
  saveErrors: {},
  lastPersisted: null,
  lastSaveError: null,
};

function stamp(change: ChangeRequest, bumpVersion = true): ChangeRequest {
  return {
    ...change,
    updatedAt: new Date().toISOString(),
    version: bumpVersion ? change.version + 1 : change.version,
  };
}

function prependAudit(change: ChangeRequest, action: string, detail: string): ChangeRequest {
  return { ...change, audit: [createAudit(action, detail), ...change.audit] };
}

/** 可签署顺位：已批准/冻结之后的第一个 pending 或 invalidated 阶段。 */
function nextSignableStage(change: ChangeRequest): ApprovalStage | null {
  for (const stage of APPROVAL_ORDER) {
    const approval = change.approvals.find((item) => item.stage === stage);
    if (!approval) {
      return stage;
    }
    if (approval.state === 'pending' || approval.state === 'invalidated') {
      return stage;
    }
    if (approval.state === 'rejected') {
      return stage;
    }
  }
  return null;
}

/**
 * 暂停或回滚后，共享资源上“尚未开始执行”的关联变更：
 * 已批准的会签一律失效，需要按原顺序重新确认。
 */
function cascadeInvalidateApprovals(
  changes: ChangeRequest[],
  source: ChangeRequest,
  reason: 'paused' | 'rolled_back',
): { changes: ChangeRequest[]; affectedIds: string[] } {
  const affectedIds: string[] = [];
  const reasonText = reason === 'paused' ? '暂停执行' : '执行回滚';

  const nextChanges = changes.map((change) => {
    if (
      change.id === source.id ||
      !['submitted', 'approved'].includes(change.status) ||
      !sharesResource(change, source)
    ) {
      return change;
    }

    const sharedNames = sharedResourceNames(change, source);
    const stagesInvalidated: ApprovalStage[] = [];
    const firstApprovedIndex = APPROVAL_ORDER.findIndex((stage) =>
      change.approvals.some((approval) => approval.stage === stage && approval.state === 'approved')
    );

    let next = prependAudit(
      change,
      '关联审批失效',
      `关联变更 ${source.id}${reasonText}，共享资源 ${sharedNames.join('、')} 上尚未开始的会签失效，需重新确认`,
    );

    // 从首个已批准顺位起整体置为失效，保证按网络→系统→安全→业务顺序重新确认
    next = {
      ...next,
      status: 'submitted',
      approvals: next.approvals.map((approval, index) => {
        if (firstApprovedIndex >= 0 && index >= firstApprovedIndex) {
          stagesInvalidated.push(approval.stage);
          return { ...approval, state: 'invalidated' as const };
        }
        return approval;
      }),
    };

    const newInvalidations: InvalidationRecord[] = stagesInvalidated
      // pending 顺位也需要重签，但它本就没有"原批准"，同样记录一条待确认
      .map((stage) => ({
        id: `inv-${Date.now()}-${stage}-${Math.random().toString(16).slice(2)}`,
        sourceChangeId: source.id,
        stage,
        approver: change.approvals.find((approval) => approval.stage === stage)?.approver,
        reason,
        invalidatedAt: new Date().toISOString(),
      }));

    if (stagesInvalidated.length === 0) {
      return change;
    }

    affectedIds.push(change.id);
    return stamp({ ...next, invalidations: [...newInvalidations, ...next.invalidations] });
  });

  return { changes: nextChanges, affectedIds };
}

function withPauseEffects(
  state: ChangeRequestState,
  sourceId: string,
  note: string,
): ChangeRequestState {
  const source = state.changes.find((change) => change.id === sourceId);
  if (!source || source.status !== 'executing' || isExecutionPaused(source)) {
    return state;
  }

  const event = createExecutionEvent('pause', note);
  const withEvent = stamp(
    prependAudit(
      { ...source, executionEvents: [event, ...source.executionEvents] },
      '暂停执行',
      note || '执行中记录暂停，关联变更未开始的会签失效',
    ),
  );
  const replaced = state.changes.map((change) => (change.id === sourceId ? withEvent : change));
  const { changes, affectedIds } = cascadeInvalidateApprovals(replaced, withEvent, 'paused');

  const finalChanges =
    affectedIds.length > 0
      ? changes.map((change) =>
          change.id === sourceId
            ? prependAudit(change, '关联审批失效', `已通知 ${affectedIds.join('、')} 重新确认会签`)
            : change,
        )
      : changes;

  return { ...state, changes: finalChanges, lastSaveError: null };
}

function withRollbackEffects(
  state: ChangeRequestState,
  sourceId: string,
  note: string,
): ChangeRequestState {
  const source = state.changes.find((change) => change.id === sourceId);
  if (!source || source.status !== 'executing') {
    return state;
  }

  const event = createExecutionEvent('rollback', note);
  const rolledBack = stamp(
    prependAudit(
      {
        ...source,
        status: 'rolled_back',
        executionEvents: [event, ...source.executionEvents],
      },
      '执行回滚',
      note || '按方案完成回滚，关联变更未开始的会签失效',
    ),
  );
  const replaced = state.changes.map((change) => (change.id === sourceId ? rolledBack : change));
  const { changes, affectedIds } = cascadeInvalidateApprovals(replaced, rolledBack, 'rolled_back');

  const finalChanges =
    affectedIds.length > 0
      ? changes.map((change) =>
          change.id === sourceId
            ? prependAudit(change, '关联审批失效', `已通知 ${affectedIds.join('、')} 重新确认会签`)
            : change,
        )
      : changes;

  return { ...state, changes: finalChanges, lastSaveError: null };
}

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { changes }) => ({
    ...state,
    changes: changes.map(normalizeChange),
    loading: false,
    lastPersisted: changes.map(normalizeChange),
  })),
  on(ChangeRequestActions.loadChangesFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(ChangeRequestActions.createChange, (state, { change }) => ({
    ...state,
    changes: [
      stamp(
        prependAudit(
          {
            ...normalizeChange(change),
            version: 1,
          },
          '创建草稿',
          `创建变更 ${change.id}`,
        ),
        false,
      ),
      ...state.changes,
    ],
    lastSaveError: null,
  })),
  on(ChangeRequestActions.updateChange, (state, { change, baseVersion }) => {
    const current = state.changes.find((item) => item.id === change.id);
    if (!current) {
      return state;
    }

    // 执行版本为准：冻结后窗口、资源、步骤方案不允许再覆盖。
    if (current.frozenSnapshot || current.executionEvents.length > 0) {
      return {
        ...state,
        saveErrors: {
          ...state.saveErrors,
          [change.id]: '执行已开始，方案和会签快照已冻结，旧页面的修改未保存。',
        },
      };
    }

    // 两个窗口同时保存：旧页面基线版本落后，拒绝覆盖新版本。
    if (current.version !== baseVersion) {
      return {
        ...state,
        saveErrors: {
          ...state.saveErrors,
          [change.id]: `版本已过期（当前 v${current.version}，页面基线 v${baseVersion}），已恢复最近有效版本，请重新编辑。`,
        },
      };
    }

    // 审批/执行类字段只以 store 当前状态为准，防止旧页面通过整单保存回写。
    const merged: ChangeRequest = {
      ...current,
      title: change.title,
      summary: change.summary,
      owner: change.owner,
      onCall: change.onCall,
      risk: change.risk,
      resources: change.resources,
      steps: change.steps,
      window: change.window,
    };

    const saveErrors = { ...state.saveErrors };
    delete saveErrors[change.id];

    return {
      ...state,
      changes: state.changes.map((item) =>
        item.id === change.id
          ? stamp(
              prependAudit(merged, '保存变更方案', `更新资源、步骤或窗口信息（v${merged.version}）`),
            )
          : item,
      ),
      saveErrors,
      lastSaveError: null,
    };
  }),
  on(ChangeRequestActions.updateChangeRejected, (state, { id, reason }) => ({
    ...state,
    saveErrors: { ...state.saveErrors, [id]: reason },
  })),
  on(ChangeRequestActions.clearSaveError, (state, { id }) => {
    const saveErrors = { ...state.saveErrors };
    delete saveErrors[id];
    return { ...state, saveErrors };
  }),
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
      const resubmitted = prependAudit(
        {
          ...change,
          status: 'submitted',
          approvals: change.approvals.map((approval) => ({
            ...approval,
            state: 'pending' as const,
            approver: undefined,
            comment: undefined,
            decidedAt: undefined,
          })),
        },
        '提交审批',
        '方案冻结后进入网络、系统、安全、业务顺序会签',
      );
      return stamp(resubmitted);
    }),
  })),
  on(ChangeRequestActions.approveStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || nextSignableStage(change) !== stage) {
        return change;
      }

      const reconfirming = change.approvals.some(
        (approval) => approval.stage === stage && approval.state === 'invalidated',
      );

      const approvals = change.approvals.map((approval) =>
        approval.stage === stage
          ? {
              ...approval,
              state: 'approved' as const,
              approver,
              comment,
              decidedAt: new Date().toISOString(),
            }
          : approval,
      );
      const allApproved = approvals.every((approval) => approval.state === 'approved');
      const nowIso = new Date().toISOString();
      const invalidations = change.invalidations.map((record) =>
        record.stage === stage && !record.reconfirmedAt && record.sourceChangeId
          ? { ...record, reconfirmedAt: nowIso, reconfirmer: approver }
          : record,
      );

      let next: ChangeRequest = {
        ...change,
        status: allApproved ? 'approved' : 'submitted',
        approvals,
        invalidations,
      };
      next = prependAudit(
        next,
        reconfirming ? '重新确认会签' : '阶段会签',
        reconfirming
          ? `${stage} 失效后由 ${approver} 重新确认：${comment}`
          : `${stage} 已由 ${approver} 批准：${comment}`,
      );
      return stamp(next);
    }),
  })),
  on(ChangeRequestActions.rejectStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || nextSignableStage(change) !== stage) {
        return change;
      }
      const rejected = prependAudit(
        {
          ...change,
          status: 'rejected',
          approvals: change.approvals.map((approval) =>
            approval.stage === stage
              ? {
                  ...approval,
                  state: 'rejected',
                  approver,
                  comment,
                  decidedAt: new Date().toISOString(),
                }
              : approval,
          ),
        },
        '审批退回',
        `${stage} 由 ${approver} 退回：${comment}`,
      );
      return stamp(rejected);
    }),
  })),
  on(ChangeRequestActions.startExecution, (state, { id }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || change.status !== 'approved') {
        return change;
      }
      const event = createExecutionEvent('start', '方案和会签快照已冻结，开始执行');
      const started = prependAudit(
        {
          ...change,
          status: 'executing',
          frozenSnapshot: buildExecutionSnapshot(change),
          approvals: change.approvals.map((approval) => ({ ...approval, state: 'frozen' })),
          executionEvents: [event, ...change.executionEvents],
        },
        '开始执行',
        `按冻结版本 v${change.version} 执行，审批记录已冻结`,
      );
      return stamp(started);
    }),
  })),
  on(ChangeRequestActions.controlExecution, (state, { id, control, note }) => {
    if (control === 'pause') {
      return withPauseEffects(state, id, note);
    }
    if (control === 'rollback') {
      return withRollbackEffects(state, id, note);
    }

    // resume：仅最近事件为暂停的执行中变更可以继续
    const source = state.changes.find((change) => change.id === id);
    if (!source || source.status !== 'executing' || !isExecutionPaused(source)) {
      return state;
    }
    const event = createExecutionEvent('resume', note);
    const resumed = stamp(
      prependAudit(
        { ...source, executionEvents: [event, ...source.executionEvents] },
        '继续执行',
        note || '暂停后继续按冻结版本执行',
      ),
    );
    return {
      ...state,
      changes: state.changes.map((change) => (change.id === id ? resumed : change)),
    };
  }),
  on(ChangeRequestActions.toggleStep, (state, { id, stepId }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? stamp(
            {
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
            },
            false,
          )
        : change,
    ),
  })),
  on(ChangeRequestActions.recordDeviation, (state, { id, deviation }) => {
    const baseState: ChangeRequestState = {
      ...state,
      changes: state.changes.map((change) =>
        change.id === id
          ? prependAudit(
              stamp(
                {
                  ...change,
                  deviations: [deviation, ...change.deviations],
                },
                false,
              ),
              '记录执行偏离',
              `${deviation.owner} [${deviation.decision}] ${deviation.description}`,
            )
          : change,
      ),
    };

    if (deviation.decision === 'pause') {
      return withPauseEffects(baseState, id, deviation.description);
    }
    if (deviation.decision === 'rollback') {
      return withRollbackEffects(baseState, id, deviation.description);
    }
    return baseState;
  }),
  on(ChangeRequestActions.completeExecution, (state, { id, result, note }) => {
    if (result === 'rolled_back') {
      return withRollbackEffects(state, id, note);
    }
    return {
      ...state,
      changes: state.changes.map((change) => {
        if (change.id !== id || change.status !== 'executing' || isExecutionPaused(change)) {
          return change;
        }
        const event = createExecutionEvent('complete', note);
        const completed = stamp(
          prependAudit(
            {
              ...change,
              status: 'completed',
              executionEvents: [event, ...change.executionEvents],
            },
            '执行完成',
            note,
          ),
        );
        return completed;
      }),
    };
  }),
  on(ChangeRequestActions.persistFailure, (state, { error, lastPersisted }) => ({
    ...state,
    changes: lastPersisted,
    lastPersisted,
    lastSaveError: error,
  })),
  on(ChangeRequestActions.persistSuccess, (state, { changes }) => ({
    ...state,
    lastPersisted: changes,
  })),
  on(ChangeRequestActions.storageSynced, (state, { changes }) => ({
    ...state,
    changes: changes.map(normalizeChange),
  })),
);

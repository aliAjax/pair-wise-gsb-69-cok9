export type ChangeStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'rolled_back'
  | 'rejected';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ResourceType = 'datacenter' | 'rack' | 'network' | 'storage' | 'service';
export type ApprovalStage = 'network' | 'system' | 'security' | 'business';
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'frozen' | 'invalidated';
export type StepPhase = 'prepare' | 'execute' | 'verify' | 'rollback';
export type IssueSeverity = 'blocker' | 'warning' | 'info';
export type DeviationDecision = 'continue' | 'pause' | 'resume' | 'rollback';

export interface ChangeResource {
  id: string;
  name: string;
  type: ResourceType;
  critical: boolean;
  dependencies: string[];
}

export interface ChangeStep {
  id: string;
  phase: StepPhase;
  title: string;
  owner: string;
  durationMinutes: number;
  command: string;
  completed: boolean;
  completedAt?: string;
}

export interface ChangeWindow {
  start: string;
  end: string;
  observationWindowMinutes: number;
  blackoutProtected: boolean;
}

export interface ApprovalRecord {
  stage: ApprovalStage;
  state: ApprovalState;
  /** 会签轮次：被失效后重新会签会开启新一轮，交接时以最大轮次为准。 */
  round: number;
  approver?: string;
  decidedAt?: string;
  comment?: string;
  invalidatedAt?: string;
  invalidatedReason?: string;
  invalidatedByChangeId?: string;
  invalidatedByEventId?: string;
}

export interface DeviationRecord {
  id: string;
  recordedAt: string;
  owner: string;
  description: string;
  decision: DeviationDecision;
  /** 触发级联失效的暂停/回滚事件 ID，用于幂等关联。 */
  eventId?: string;
}

/** 开始执行时冻结的执行版本：执行与复盘一律以此快照为准。 */
export interface ExecutionSnapshot {
  frozenAt: string;
  version: number;
  window: ChangeWindow;
  resources: ChangeResource[];
  steps: ChangeStep[];
  approvals: ApprovalRecord[];
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  detail: string;
}

export interface ChangeRequest {
  id: string;
  title: string;
  summary: string;
  owner: string;
  onCall: string[];
  status: ChangeStatus;
  risk: RiskLevel;
  resources: ChangeResource[];
  steps: ChangeStep[];
  window: ChangeWindow;
  approvals: ApprovalRecord[];
  deviations: DeviationRecord[];
  audit: AuditRecord[];
  /** 乐观锁版本，每次变更递增；保存时携带基线版本防止旧页面覆盖。 */
  version: number;
  /** 存在即代表执行已开始，方案和会签已冻结，任何保存不得覆盖。 */
  executionSnapshot?: ExecutionSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  id: string;
  changeId: string;
  severity: IssueSeverity;
  code:
    | 'DEPENDENCY_MISSING'
    | 'WINDOW_CONFLICT'
    | 'ROLLBACK_UNEXECUTABLE'
    | 'OBSERVATION_TOO_SHORT'
    | 'OWNER_MISSING';
  title: string;
  detail: string;
  suggestedAction: string;
  relatedId?: string;
}

export const APPROVAL_ORDER: ApprovalStage[] = ['network', 'system', 'security', 'business'];

export const STATUS_LABELS: Record<ChangeStatus, string> = {
  draft: '草稿',
  submitted: '待会签',
  approved: '已批准',
  executing: '执行中',
  paused: '已暂停',
  completed: '已完成',
  rolled_back: '已回滚',
  rejected: '已退回',
};

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '严重',
};

export const RESOURCE_LABELS: Record<ResourceType, string> = {
  datacenter: '机房',
  rack: '机柜',
  network: '网络',
  storage: '存储',
  service: '服务',
};

export const STAGE_LABELS: Record<ApprovalStage, string> = {
  network: '网络负责人',
  system: '系统负责人',
  security: '安全负责人',
  business: '业务负责人',
};

export const PHASE_LABELS: Record<StepPhase, string> = {
  prepare: '准备',
  execute: '执行',
  verify: '验证',
  rollback: '回滚',
};

export const DECISION_LABELS: Record<DeviationDecision, string> = {
  continue: '继续观察',
  pause: '暂停执行',
  resume: '继续执行',
  rollback: '立即回滚',
};

export function createEmptyApprovals(round = 1): ApprovalRecord[] {
  return APPROVAL_ORDER.map((stage) => ({ stage, state: 'pending' as const, round }));
}

export function createEmptyChange(): ChangeRequest {
  const now = new Date();
  const start = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  return {
    id: `CHG-${Math.floor(1000 + Math.random() * 9000)}`,
    title: '',
    summary: '',
    owner: '',
    onCall: [],
    status: 'draft',
    risk: 'medium',
    resources: [],
    steps: [],
    window: {
      start: toLocalInputValue(start),
      end: toLocalInputValue(end),
      observationWindowMinutes: 30,
      blackoutProtected: false,
    },
    approvals: createEmptyApprovals(),
    deviations: [],
    audit: [],
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function toLocalInputValue(date: Date): string {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

export function isWindowOverlapping(left: ChangeWindow, right: ChangeWindow): boolean {
  const leftStart = new Date(left.start).getTime();
  const leftEnd = new Date(left.end).getTime();
  const rightStart = new Date(right.start).getTime();
  const rightEnd = new Date(right.end).getTime();
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function validateChange(change: ChangeRequest, allChanges: ChangeRequest[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const resourceMap = new Map(change.resources.map((resource) => [resource.id, resource]));

  change.resources.forEach((resource) => {
    resource.dependencies
      .filter((dependencyId) => !resourceMap.has(dependencyId))
      .forEach((dependencyId) => {
        issues.push({
          id: `${change.id}-dependency-${resource.id}-${dependencyId}`,
          changeId: change.id,
          severity: 'blocker',
          code: 'DEPENDENCY_MISSING',
          title: `缺少依赖对象 ${dependencyId}`,
          detail: `${resource.name} 依赖 ${dependencyId}，但该对象未纳入本次变更范围。`,
          suggestedAction: '补充依赖对象，或提供不在范围内的书面依据。',
          relatedId: dependencyId,
        });
      });
  });

  allChanges
    .filter(
      (candidate) =>
        candidate.id !== change.id &&
        !['draft', 'rejected', 'rolled_back'].includes(candidate.status) &&
        isWindowOverlapping(change.window, candidate.window),
    )
    .forEach((candidate) => {
      const shared = change.resources.filter((resource) =>
        candidate.resources.some((candidateResource) => candidateResource.id === resource.id),
      );
      if (shared.length > 0) {
        issues.push({
          id: `${change.id}-conflict-${candidate.id}`,
          changeId: change.id,
          severity: 'blocker',
          code: 'WINDOW_CONFLICT',
          title: `与 ${candidate.id} 存在窗口冲突`,
          detail: `共享资源：${shared.map((resource) => resource.name).join('、')}。两项变更的执行窗口发生重叠。`,
          suggestedAction: '调整窗口、串行等待，或将冲突资源移出本次范围。',
          relatedId: candidate.id,
        });
      }
    });

  change.steps
    .filter((step) => step.phase === 'rollback' && (!step.command.trim() || !step.owner.trim()))
    .forEach((step) => {
      issues.push({
        id: `${change.id}-rollback-${step.id}`,
        changeId: change.id,
        severity: 'blocker',
        code: 'ROLLBACK_UNEXECUTABLE',
        title: `回滚步骤“${step.title || '未命名'}”不可执行`,
        detail: '回滚步骤必须包含明确命令或操作说明，并指定责任人。',
        suggestedAction: '补齐回滚命令和责任人后重新校验。',
        relatedId: step.id,
      });
    });

  change.resources
    .filter((resource) => resource.type === 'service' && resource.critical)
    .forEach((resource) => {
      if (change.window.observationWindowMinutes < 30) {
        issues.push({
          id: `${change.id}-observation-${resource.id}`,
          changeId: change.id,
          severity: 'warning',
          code: 'OBSERVATION_TOO_SHORT',
          title: `${resource.name} 观察窗口不足`,
          detail: '关键服务建议至少保留 30 分钟观察窗口。',
          suggestedAction: '延长观察窗口，并由业务负责人签署风险接受记录。',
          relatedId: resource.id,
        });
      }
    });

  if (!change.owner.trim() || change.onCall.length === 0) {
    issues.push({
      id: `${change.id}-owner`,
      changeId: change.id,
      severity: 'blocker',
      code: 'OWNER_MISSING',
      title: '缺少变更责任人',
      detail: '变更负责人与值守人员均不能为空。',
      suggestedAction: '指定变更负责人和至少一名值守人员。',
    });
  }

  return issues;
}

export function createAudit(
  action: string,
  detail: string,
  actor = '当前用户',
  timestamp = new Date().toISOString(),
): AuditRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp,
    actor,
    action,
    detail,
  };
}

// ---------------------------------------------------------------------------
// 执行版本、会签轮次与级联失效
// ---------------------------------------------------------------------------

/** 执行是否已开始（以冻结快照为准，覆盖执行中、暂停、完成、回滚）。 */
export function isExecutionFrozen(change: ChangeRequest): boolean {
  return !!change.executionSnapshot;
}

export function approvalRound(change: ChangeRequest): number {
  return change.approvals.reduce((max, approval) => Math.max(max, approval.round || 1), 1);
}

/** 当前有效会签轮次的记录，交接时只有这一轮可能被签署。 */
export function activeApprovals(change: ChangeRequest): ApprovalRecord[] {
  const round = approvalRound(change);
  return APPROVAL_ORDER.map(
    (stage) =>
      change.approvals.find(
        (approval) => approval.stage === stage && (approval.round || 1) === round,
      ) as ApprovalRecord,
  ).filter(Boolean);
}

/** 已失效的历史会签记录，按轮次倒序用于复盘展示。 */
export function invalidatedApprovals(change: ChangeRequest): ApprovalRecord[] {
  return change.approvals
    .filter((approval) => approval.state === 'invalidated')
    .sort((left, right) => (right.round || 1) - (left.round || 1));
}

export function nextPendingStage(change: ChangeRequest): ApprovalStage | null {
  if (!['submitted', 'rejected'].includes(change.status)) {
    return null;
  }
  const active = activeApprovals(change);
  return (
    active.find((approval) => approval.state === 'rejected')?.stage ??
    active.find((approval) => approval.state === 'pending')?.stage ??
    null
  );
}

export function buildExecutionSnapshot(
  change: ChangeRequest,
  frozenAt = new Date().toISOString(),
): ExecutionSnapshot {
  return {
    frozenAt,
    version: change.version ?? 1,
    window: structuredClone(change.window),
    resources: structuredClone(change.resources),
    steps: structuredClone(change.steps),
    approvals: activeApprovals(change).map((approval) => ({
      ...structuredClone(approval),
      state: 'frozen' as const,
    })),
  };
}

/** 与本变更共享任一资源的其他变更（关联变更）。 */
export function sharedResourceChanges(
  change: ChangeRequest,
  allChanges: ChangeRequest[],
): ChangeRequest[] {
  return allChanges.filter(
    (candidate) =>
      candidate.id !== change.id &&
      candidate.resources.some((resource) =>
        change.resources.some((owned) => owned.id === resource.id),
      ),
  );
}

/** 因本变更暂停/回滚而被失效审批的关联变更。 */
export function causedInvalidations(
  change: ChangeRequest,
  allChanges: ChangeRequest[],
): ChangeRequest[] {
  return allChanges.filter(
    (candidate) =>
      candidate.id !== change.id &&
      candidate.approvals.some(
        (approval) => approval.invalidatedByChangeId === change.id,
      ),
  );
}

export interface CascadeAffectedChange {
  id: string;
  title: string;
  stages: ApprovalStage[];
  resources: string[];
}

interface CascadeParams {
  sourceId: string;
  eventId: string;
  reason: string;
  at: string;
  actor: string;
}

/**
 * 记录暂停或回滚后，共享资源上“尚未开始”的关联变更审批一律失效：
 * 当前有效轮次标记 invalidated，并开启下一轮 pending 会签，需重新确认。
 * 已开始（已有冻结快照）的变更不受影响；同一事件幂等。
 */
export function applyCascadeInvalidation(
  changes: ChangeRequest[],
  params: CascadeParams,
): { changes: ChangeRequest[]; affected: CascadeAffectedChange[] } {
  const source = changes.find((change) => change.id === params.sourceId);
  if (!source) {
    return { changes, affected: [] };
  }

  const affected: CascadeAffectedChange[] = [];

  const next = changes.map((change) => {
    if (change.id === params.sourceId || isExecutionFrozen(change)) {
      return change;
    }
    if (!['submitted', 'approved'].includes(change.status)) {
      return change;
    }
    if (change.approvals.some((approval) => approval.invalidatedByEventId === params.eventId)) {
      return change;
    }

    const shared = change.resources.filter((resource) =>
      source.resources.some((sourceResource) => sourceResource.id === resource.id),
    );
    if (shared.length === 0) {
      return change;
    }

    const round = approvalRound(change);
    const stages: ApprovalStage[] = [];
    const history = change.approvals.map((approval) => {
      if ((approval.round || 1) !== round || !['pending', 'approved'].includes(approval.state)) {
        return approval;
      }
      stages.push(approval.stage);
      const invalidated: ApprovalRecord = {
        ...approval,
        state: 'invalidated',
        invalidatedAt: params.at,
        invalidatedReason: params.reason,
        invalidatedByChangeId: params.sourceId,
        invalidatedByEventId: params.eventId,
      };
      return invalidated;
    });

    const nextRound = round + 1;
    const reopened = createEmptyApprovals(nextRound);
    affected.push({
      id: change.id,
      title: change.title,
      stages: [...stages].sort(
        (left, right) => APPROVAL_ORDER.indexOf(left) - APPROVAL_ORDER.indexOf(right),
      ),
      resources: shared.map((resource) => resource.name),
    });

    const ordered = [...history, ...reopened].sort((left, right) => {
      const roundDiff = (left.round || 1) - (right.round || 1);
      return (
        roundDiff ||
        APPROVAL_ORDER.indexOf(left.stage) - APPROVAL_ORDER.indexOf(right.stage)
      );
    });

    return {
      ...change,
      status: 'submitted' as const,
      version: (change.version ?? 1) + 1,
      updatedAt: params.at,
      approvals: ordered,
      audit: [
        createAudit(
          '关联审批失效',
          `共享资源 ${shared.map((resource) => resource.name).join('、')}：${params.reason}，` +
            `原第 ${round} 轮 ${stages.length} 个会签节点失效，自网络负责人起重新会签。`,
          params.actor,
          params.at,
        ),
        ...change.audit,
      ],
    };
  });

  if (affected.length === 0) {
    return { changes, affected };
  }

  const withSourceNotice = next.map((change) =>
    change.id === params.sourceId
      ? {
          ...change,
          audit: [
            createAudit(
              '关联审批失效通知',
              `${params.reason}，以下尚未开始的关联变更审批失效，需重新确认：` +
                affected.map((item) => item.id).join('、'),
              params.actor,
              params.at,
            ),
            ...change.audit,
          ],
        }
      : change,
  );

  return { changes: withSourceNotice, affected };
}

/** 兼容历史数据：补齐版本、轮次，并为已开始的变更补建冻结快照。 */
export function normalizeChange(raw: ChangeRequest): ChangeRequest {
  const change: ChangeRequest = {
    ...raw,
    version: typeof raw.version === 'number' && raw.version > 0 ? raw.version : 1,
    approvals: (raw.approvals?.length ? raw.approvals : createEmptyApprovals()).map((approval) => ({
      ...approval,
      round: typeof approval.round === 'number' ? approval.round : 1,
    })),
    deviations: raw.deviations ?? [],
    audit: raw.audit ?? [],
  };

  if (change.status === 'executing' && !change.executionSnapshot) {
    const latest = change.deviations[0];
    if (latest?.decision === 'pause') {
      change.status = 'paused';
    }
  }

  if (
    ['executing', 'paused', 'completed', 'rolled_back'].includes(change.status) &&
    !change.executionSnapshot
  ) {
    change.executionSnapshot = buildExecutionSnapshot(change, change.updatedAt);
  }

  return change;
}

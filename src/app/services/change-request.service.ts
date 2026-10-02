import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, Observable, of, tap } from 'rxjs';
import {
  ChangeRequest,
  DECISION_LABELS,
  invalidatedApprovals,
  isExecutionFrozen,
  normalizeChange,
  STAGE_LABELS,
  STATUS_LABELS,
  causedInvalidations,
} from '../models/change-request.model';
import { SaveConflictInfo } from '../store/change-request.actions';

export const STORAGE_KEY = 'pair-wise-gsb-69-changes';

export interface ReconcileResult {
  /** 对账后应持久化的完整列表（保留对方更新的版本）。 */
  merged: ChangeRequest[];
  /** 本窗口是否存在被拒绝的过期/冻结写入。 */
  conflict?: SaveConflictInfo;
}

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
  private readonly http = inject(HttpClient);

  load(): Observable<ChangeRequest[]> {
    const localValue = localStorage.getItem(STORAGE_KEY);
    if (localValue) {
      try {
        return of((JSON.parse(localValue) as ChangeRequest[]).map(normalizeChange));
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

    return this.http.get<ChangeRequest[]>('/mock/change-requests.json').pipe(
      tap((changes) => this.save(changes.map(normalizeChange))),
      catchError((error: unknown) => {
        console.error('Failed to load change request data', error);
        return of([]);
      }),
    );
  }

  save(changes: ChangeRequest[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changes));
  }

  /** 直接读取当前磁盘上的其他窗口数据（可能已被其他页面更新）。 */
  readStored(): ChangeRequest[] {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) {
      return [];
    }
    try {
      return (JSON.parse(value) as ChangeRequest[]).map(normalizeChange);
    } catch {
      return [];
    }
  }

  /**
   * 两个窗口同时保存时以执行版本/新版本为准：
   * - 磁盘版本比本窗口当前版本更新，或磁盘已冻结而本窗口未冻结，则保留磁盘版本、拒绝过期写入；
   * - 本窗口新增、以及磁盘已不存在的变更（删除）正常落盘。
   *
   * @param next 本窗口 reducer 计算出的新列表
   * @param attemptedVersionById 本窗口写入前各变更的当前版本；
   *   保存操作携带编辑器打开时的基线，其余操作为递增前版本。
   */
  reconcilePersist(
    next: ChangeRequest[],
    attemptedVersionById: Map<string, number>,
  ): ReconcileResult {
    const stored = this.readStored();
    const storedById = new Map(stored.map((change) => [change.id, change]));
    const nextById = new Map(next.map((change) => [change.id, change]));

    let conflict: SaveConflictInfo | undefined;
    const merged: ChangeRequest[] = [];

    for (const diskChange of stored) {
      const incoming = nextById.get(diskChange.id);
      if (!incoming) {
        // 本窗口写入未包含该记录（如删除草稿），以本窗口为准。
        continue;
      }
      const attempted = attemptedVersionById.get(diskChange.id);
      const frozenClobber = isExecutionFrozen(diskChange) && !isExecutionFrozen(incoming);
      const stale =
        attempted !== undefined &&
        (frozenClobber || diskChange.version > attempted);
      if (stale && !conflict) {
        conflict = {
          id: diskChange.id,
          reason: frozenClobber ? 'frozen' : 'stale',
          currentVersion: diskChange.version,
          attemptedVersion: attempted,
        };
      }
      merged.push(stale ? diskChange : incoming);
    }

    for (const change of next) {
      if (!storedById.has(change.id)) {
        merged.push(change);
      }
    }

    return { merged, conflict };
  }

  exportRetrospective(change: ChangeRequest, allChanges: ChangeRequest[]): string {
    const snapshot = change.executionSnapshot;
    const frozenWindow = snapshot ? snapshot.window : change.window;
    const invalidated = invalidatedApprovals(change);
    const cascaded = causedInvalidations(change, allChanges);

    const lines = [
      `# ${change.id} ${change.title} 复盘记录`,
      '',
      `最终状态：${STATUS_LABELS[change.status] ?? change.status}`,
      `负责人：${change.owner}`,
      `执行版本：v${snapshot ? snapshot.version : change.version}${
        snapshot ? `（${snapshot.frozenAt} 冻结）` : '（尚未开始执行）'
      }`,
      `冻结窗口：${frozenWindow.start} - ${frozenWindow.end}（观察窗口 ${frozenWindow.observationWindowMinutes} 分钟）`,
      `风险等级：${change.risk}`,
      '',
      '## 冻结方案快照',
      ...(snapshot
        ? [
            ...snapshot.resources.map(
              (resource) =>
                `- 资源 ${resource.id} ${resource.name}（${resource.type}${
                  resource.critical ? '，关键' : ''
                }，依赖 ${resource.dependencies.length} 项）`,
            ),
            '',
            '会签快照：',
            ...snapshot.approvals.map(
              (approval) =>
                `- 第 ${approval.round} 轮 ${STAGE_LABELS[approval.stage]}：已冻结` +
                (approval.approver ? `，批准人 ${approval.approver}` : ''),
            ),
          ]
        : ['- 未生成执行冻结快照']),
      '',
      '## 执行过程（暂停 / 继续 / 回滚）',
      ...(change.deviations.length
        ? change.deviations.map(
            (item) =>
              `- ${item.recordedAt} ${item.owner} [${DECISION_LABELS[item.decision] ?? item.decision}] ${item.description}`,
          )
        : ['- 无']),
      '',
      '## 失效审批（原会签不再有效，需重新确认）',
      ...(invalidated.length
        ? invalidated.map(
            (approval) =>
              `- 第 ${approval.round} 轮 ${STAGE_LABELS[approval.stage]}：` +
                `原${approval.state === 'invalidated' ? '会签' : ''}失效，原因：${
                  approval.invalidatedReason ?? '关联变更暂停或回滚'
                }，触发变更 ${approval.invalidatedByChangeId ?? '-'}，时间 ${
                  approval.invalidatedAt ?? '-'
                }`,
          )
        : ['- 无']),
      '',
      '## 受影响的关联变更',
      ...(cascaded.length
        ? cascaded.map((item) => {
            const stages = invalidatedApprovals(item)
              .filter((approval) => approval.invalidatedByChangeId === change.id)
              .map((approval) => STAGE_LABELS[approval.stage]);
            return `- ${item.id} ${item.title}：共享资源 ${item.resources
              .filter((resource) =>
                change.resources.some((owned) => owned.id === resource.id),
              )
              .map((resource) => resource.name)
              .join('、')}，失效节点 ${stages.join('、') || '（全部）'}，需重新会签`;
          })
        : ['- 无']),
      '',
      '## 审计轨迹',
      ...change.audit.map(
        (item) => `- ${item.timestamp} ${item.actor} ${item.action}：${item.detail}`,
      ),
    ];
    return lines.join('\n');
  }
}

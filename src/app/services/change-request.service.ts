import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, Observable, of, tap } from 'rxjs';
import {
  ChangeRequest,
  EXECUTION_EVENT_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  normalizeChange,
  sharedResourceNames,
} from '../models/change-request.model';

const STORAGE_KEY = 'pair-wise-gsb-69-changes';
const STAGING_KEY = 'pair-wise-gsb-69-changes-staging';
const BACKUP_KEY = 'pair-wise-gsb-69-changes-backup';

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
  private readonly http = inject(HttpClient);

  load(): Observable<ChangeRequest[]> {
    const localValue = this.readWithRecovery();
    if (localValue) {
      return of(localValue);
    }

    return this.http.get<ChangeRequest[]>('/mock/change-requests.json').pipe(
      tap((changes) => this.save(changes)),
      catchError((error: unknown) => {
        console.error('Failed to load change requests', error);
        return of([]);
      }),
    );
  }

  /**
   * 暂存键 + 正式键 + 上一有效版本备份的三段式写入：
   * 写入中断时优先恢复正式键，正式键损坏则回退备份键，
   * 保证重新打开时拿到的是最近有效执行版本。
   */
  private readWithRecovery(): ChangeRequest[] | null {
    const parse = (raw: string | null): ChangeRequest[] | null => {
      if (!raw) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(normalizeChange) : null;
      } catch {
        return null;
      }
    };

    const staging = parse(localStorage.getItem(STAGING_KEY));
    const primary = parse(localStorage.getItem(STORAGE_KEY));
    const backup = parse(localStorage.getItem(BACKUP_KEY));

    if (staging && this.isNewer(staging, primary)) {
      // 上次提交在暂存后中断：暂存即最新成功序列化的版本
      this.commit(staging);
      localStorage.removeItem(STAGING_KEY);
      return staging;
    }

    if (primary) {
      return primary;
    }

    if (backup) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(backup));
      return backup;
    }

    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STAGING_KEY);
    localStorage.removeItem(BACKUP_KEY);
    return null;
  }

  private isNewer(candidate: ChangeRequest[], baseline: ChangeRequest[] | null): boolean {
    if (!baseline) {
      return true;
    }
    const candidateMax = Math.max(0, ...candidate.map((item) => item.version));
    const baselineMax = Math.max(0, ...baseline.map((item) => item.version));
    return candidateMax > baselineMax;
  }

  /**
   * 原子写入：先写暂存键，再用备份保护当前正式键，最后覆盖正式键。
   * 任何一步抛错（配额/隐私模式）都会抛出，由 effect 回滚内存状态。
   */
  save(changes: ChangeRequest[]): void {
    const serialized = JSON.stringify(changes);
    const previous = localStorage.getItem(STORAGE_KEY);

    try {
      localStorage.setItem(STAGING_KEY, serialized);
      if (previous) {
        localStorage.setItem(BACKUP_KEY, previous);
      }
      localStorage.setItem(STORAGE_KEY, serialized);
      localStorage.removeItem(STAGING_KEY);
    } catch (error) {
      localStorage.removeItem(STAGING_KEY);
      throw error;
    }
  }

  private commit(changes: ChangeRequest[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changes));
  }

  exportRetrospective(change: ChangeRequest, allChanges: ChangeRequest[] = []): string {
    const frozen = change.frozenSnapshot;
    const windowLine = frozen
      ? `冻结窗口：${frozen.window.start} - ${frozen.window.end}（v${frozen.version}）
当前窗口：${change.window.start} - ${change.window.end}`
      : `窗口：${change.window.start} - ${change.window.end}`;

    const invalidated = change.invalidations;
    const relatedAffected = allChanges.filter((candidate) =>
      candidate.invalidations.some((record) => record.sourceChangeId === change.id),
    );

    const lines = [
      `# ${change.id} ${change.title} 复盘记录`,
      '',
      `状态：${STATUS_LABELS[change.status] ?? change.status}`,
      `负责人：${change.owner}`,
      windowLine,
      `风险等级：${change.risk}`,
      '',
      '## 执行版本（冻结快照）',
      ...(frozen
        ? [
            `- 冻结时间：${frozen.frozenAt}`,
            `- 冻结版本：v${frozen.version}`,
            `- 值守人员：${frozen.onCall.join('、') || '未指定'}`,
            `- 资源范围：${frozen.resources.map((resource) => resource.name).join('、') || '无'}`,
            ...frozen.approvals.map(
              (approval) =>
                `- 会签 ${STAGE_LABELS[approval.stage]}：${approval.approver ?? '-'}（${approval.decidedAt ?? '-'}）`,
            ),
          ]
        : ['- 未进入执行，无冻结快照']),
      '',
      '## 执行事件（暂停/继续/回滚）',
      ...(change.executionEvents.length
        ? change.executionEvents.map(
            (event) =>
              `- ${event.timestamp} ${event.actor} [${EXECUTION_EVENT_LABELS[event.type]}] ${event.note}`,
          )
        : ['- 无']),
      '',
      '## 执行偏离',
      ...(change.deviations.length
        ? change.deviations.map(
            (item) =>
              `- ${item.recordedAt} ${item.owner} [${item.decision}] ${item.description}`,
          )
        : ['- 无']),
      '',
      '## 失效审批与重新确认',
      ...(invalidated.length
        ? invalidated.map((item) => {
            const reasonText = item.reason === 'paused' ? '关联变更暂停' : '关联变更回滚';
            const reconfirm = item.reconfirmedAt
              ? `，已由 ${item.reconfirmer ?? '-'} 于 ${item.reconfirmedAt} 重新确认`
              : '，尚未重新确认';
            return `- ${STAGE_LABELS[item.stage]}（原审批人：${item.approver ?? '-'}）因 ${reasonText}（${item.sourceChangeId}）于 ${item.invalidatedAt} 失效${reconfirm}`;
          })
        : ['- 无']),
      '',
      '## 关联变更影响',
      ...(relatedAffected.length
        ? relatedAffected.map((candidate) => {
            const shared = sharedResourceNames(change, candidate).join('、') || '-';
            const count = candidate.invalidations.filter(
              (record) => record.sourceChangeId === change.id,
            ).length;
            return `- ${candidate.id} ${candidate.title}：共享资源 ${shared}，${count} 项会签失效，当前状态 ${STATUS_LABELS[candidate.status] ?? candidate.status}`;
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

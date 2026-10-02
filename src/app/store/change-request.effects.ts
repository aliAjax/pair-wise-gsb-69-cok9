import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Action, Store } from '@ngrx/store';
import { catchError, EMPTY, fromEvent, map, of, switchMap, tap, withLatestFrom } from 'rxjs';
import { ChangeRequestService, STORAGE_KEY } from '../services/change-request.service';
import { ChangeRequestActions } from './change-request.actions';
import { selectAllChanges } from './change-request.selectors';

const MUTATING_ACTIONS = [
  ChangeRequestActions.createChange,
  ChangeRequestActions.updateChange,
  ChangeRequestActions.submitForReview,
  ChangeRequestActions.approveStage,
  ChangeRequestActions.rejectStage,
  ChangeRequestActions.startExecution,
  ChangeRequestActions.toggleStep,
  ChangeRequestActions.recordExecutionDecision,
  ChangeRequestActions.completeExecution,
] as const;

@Injectable()
export class ChangeRequestEffects {
  private readonly actions$ = inject(Actions);
  private readonly service = inject(ChangeRequestService);
  private readonly store = inject(Store);

  loadChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.loadChanges),
      switchMap(() =>
        this.service.load().pipe(
          map((changes) => ChangeRequestActions.loadChangesSuccess({ changes })),
          catchError((error: unknown) =>
            of(
              ChangeRequestActions.loadChangesFailure({
                error: error instanceof Error ? error.message : '变更数据加载失败',
              }),
            ),
          ),
        ),
      ),
    ),
  );

  // 删除草稿：以本窗口为准直接落盘，不参与版本对账。
  deleteDraftPersist$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(ChangeRequestActions.deleteDraft),
        withLatestFrom(this.store.select(selectAllChanges)),
        tap(([, changes]) => this.service.save(changes)),
      ),
    { dispatch: false },
  );

  // 所有变更写入先与磁盘对账：旧页面不得覆盖更新或已冻结的执行版本。
  persistChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(...MUTATING_ACTIONS),
      withLatestFrom(this.store.select(selectAllChanges)),
      switchMap(([action, changes]) => {
        try {
          const baseVersions = this.collectBaseVersions(action, changes);
          const { merged, conflict } = this.service.reconcilePersist(changes, baseVersions);
          this.service.save(merged);
          return of(ChangeRequestActions.externalChangesSynced({ changes: merged, conflict }));
        } catch (error) {
          return of(
            ChangeRequestActions.persistFailure({
              error: error instanceof Error ? error.message : '保存失败',
            }),
          );
        }
      }),
    ),
  );

  // 其他窗口写入 localStorage 时，本窗口恢复为最近有效执行版本。
  crossTabSync$ = createEffect(() =>
    fromEvent<StorageEvent>(window, 'storage').pipe(
      switchMap((event) => {
        if (event.key !== STORAGE_KEY || !event.newValue) {
          return EMPTY;
        }
        try {
          const changes = this.service.readStored();
          return of(ChangeRequestActions.externalChangesSynced({ changes }));
        } catch {
          return EMPTY;
        }
      }),
    ),
  );

  /**
   * 收集本次写入涉及的变更及其写入前（基线）版本。
   * 保存操作携带编辑器打开时的基线；其余操作本窗口内恰好递增一次，
   * 级联失效的关联变更同样递增一次。
   */
  private collectBaseVersions(
    action: Action,
    changes: ReturnType<typeof selectAllChanges.projector>,
  ): Map<string, number> {
    const baseVersions = new Map<string, number>();
    const id =
      'id' in action && typeof (action as { id?: unknown }).id === 'string'
        ? ((action as { id: string }).id)
        : undefined;

    if (action.type === ChangeRequestActions.updateChange.type) {
      const payload = action as unknown as { id: string; baseVersion: number };
      baseVersions.set(payload.id, payload.baseVersion);
      return baseVersions;
    }

    if (id) {
      const primary = changes.find((change) => change.id === id);
      if (primary) {
        baseVersions.set(id, primary.version - 1);
      }
      // 暂停/回滚级联失效的关联变更同样递增了一次。
      const eventId =
        'eventId' in action ? (action as { eventId?: string }).eventId : undefined;
      if (eventId) {
        changes
          .filter(
            (change) =>
              change.id !== id &&
              change.approvals.some(
                (approval) => approval.invalidatedByEventId === eventId,
              ),
          )
          .forEach((change) => baseVersions.set(change.id, change.version - 1));
      }
    }

    return baseVersions;
  }
}

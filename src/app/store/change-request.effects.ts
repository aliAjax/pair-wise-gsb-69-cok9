import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { catchError, filter, fromEvent, map, of, switchMap, withLatestFrom } from 'rxjs';
import { ChangeRequest } from '../models/change-request.model';
import { ChangeRequestService } from '../services/change-request.service';
import { ChangeRequestActions } from './change-request.actions';
import { selectChangeRequestState } from './change-request.selectors';

@Injectable()
export class ChangeRequestEffects {
  private readonly actions$ = inject(Actions);
  private readonly service = inject(ChangeRequestService);
  private readonly store = inject(Store);

  private readonly mutatingActions$ = this.actions$.pipe(
    ofType(
      ChangeRequestActions.createChange,
      ChangeRequestActions.updateChange,
      ChangeRequestActions.deleteDraft,
      ChangeRequestActions.submitForReview,
      ChangeRequestActions.approveStage,
      ChangeRequestActions.rejectStage,
      ChangeRequestActions.startExecution,
      ChangeRequestActions.controlExecution,
      ChangeRequestActions.toggleStep,
      ChangeRequestActions.recordDeviation,
      ChangeRequestActions.completeExecution,
      ChangeRequestActions.storageSynced,
    ),
  );

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

  /**
   * 乐观更新：reducer 先改内存，此处负责持久化。
   * - 成功：记住当前版本为“最近有效执行版本”基线
   * - 失败：回滚内存到最近一次成功持久化版本，页面随之恢复
   */
  persistChanges$ = createEffect(() =>
    this.mutatingActions$.pipe(
      withLatestFrom(this.store.select(selectChangeRequestState)),
      map(([, state]) => {
        // updateChange 被并发/冻结规则拒绝时 state 不会变化，无需写入
        try {
          this.service.save(state.changes);
          return ChangeRequestActions.persistSuccess({ changes: state.changes });
        } catch (error) {
          return ChangeRequestActions.persistFailure({
            error: error instanceof Error ? error.message : '保存到浏览器存储失败',
            lastPersisted: state.lastPersisted ?? [],
          });
        }
      }),
    ),
  );

  /** 其他标签页保存后，本标签页自动同步，避免旧页面继续编辑过期版本。 */
  syncFromStorage$ = createEffect(() =>
    fromEvent<StorageEvent>(window, 'storage').pipe(
      filter((event) => event.key === 'pair-wise-gsb-69-changes' && !!event.newValue),
      switchMap((event) => {
        try {
          const changes = JSON.parse(event.newValue as string) as ChangeRequest[];
          return of(ChangeRequestActions.storageSynced({ changes }));
        } catch {
          return of();
        }
      }),
    ),
  );
}

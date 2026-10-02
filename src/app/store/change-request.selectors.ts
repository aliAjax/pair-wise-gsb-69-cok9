import { createFeatureSelector, createSelector } from '@ngrx/store';
import {
  ChangeRequest,
  isExecutionLocked,
  isExecutionPaused,
} from '../models/change-request.model';
import { ChangeRequestState } from './change-request.reducer';

export const selectChangeRequestState =
  createFeatureSelector<ChangeRequestState>('changeRequests');

export const selectAllChanges = createSelector(
  selectChangeRequestState,
  (state) => state.changes,
);

export const selectChangesLoading = createSelector(
  selectChangeRequestState,
  (state) => state.loading,
);

export const selectChangesError = createSelector(
  selectChangeRequestState,
  (state) => state.error,
);

export const selectLastSaveError = createSelector(
  selectChangeRequestState,
  (state) => state.lastSaveError,
);

export const selectChangeById = (id: string) =>
  createSelector(selectAllChanges, (changes) =>
    changes.find((change) => change.id === id),
  );

export const selectSaveErrorFor = (id: string) =>
  createSelector(selectChangeRequestState, (state) => state.saveErrors[id] ?? null);

/** 暂停/回滚导致本变更会签失效的关联变更（尚未开始执行）。 */
export const selectAffectedRelatedChanges = (sourceId: string) =>
  createSelector(selectAllChanges, (changes) =>
    changes.filter(
      (change) =>
        change.id !== sourceId &&
        change.invalidations.some((record) => record.sourceChangeId === sourceId),
    ),
  );

export function selectChangeExecutionLocked(id: string) {
  return createSelector(selectChangeById(id), (change: ChangeRequest | undefined) =>
    change ? isExecutionLocked(change) : false,
  );
}

export function selectChangeExecutionPaused(id: string) {
  return createSelector(selectChangeById(id), (change: ChangeRequest | undefined) =>
    change ? isExecutionPaused(change) : false,
  );
}

import { DatePipe, NgClass } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { Store } from '@ngrx/store';
import { AuditTrailComponent } from '../../components/audit-trail/audit-trail.component';
import { DependencyGraphComponent } from '../../components/dependency-graph/dependency-graph.component';
import { ValidationPanelComponent } from '../../components/validation-panel/validation-panel.component';
import { WindowGanttComponent } from '../../components/window-gantt/window-gantt.component';
import {
  ApprovalStage,
  ChangeRequest,
  ChangeStep,
  DeviationRecord,
  EXECUTION_EVENT_LABELS,
  ExecutionControl,
  ExecutionEventRecord,
  PHASE_LABELS,
  RESOURCE_LABELS,
  RISK_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  isExecutionLocked,
  isExecutionPaused,
  validateChange,
} from '../../models/change-request.model';
import { ChangeRequestService } from '../../services/change-request.service';
import { ChangeRequestActions } from '../../store/change-request.actions';
import {
  selectAffectedRelatedChanges,
  selectAllChanges,
  selectLastSaveError,
  selectSaveErrorFor,
} from '../../store/change-request.selectors';

type DetailTab = 'overview' | 'dependency' | 'window' | 'execution' | 'approval' | 'audit';

@Component({
  selector: 'app-change-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    NgClass,
    FormsModule,
    RouterLink,
    ClarityModule,
    AuditTrailComponent,
    DependencyGraphComponent,
    ValidationPanelComponent,
    WindowGanttComponent,
  ],
  template: `
    @if (change(); as item) {
      <section class="detail-heading">
        <div class="heading-main">
          <a routerLink="/" class="back-link">返回变更队列</a>
          <div class="title-row">
            <div>
              <span class="change-id">{{ item.id }}</span>
              <h1>{{ item.title }}</h1>
            </div>
            <span class="status" [class]="item.status">{{ statusLabel(item.status) }}</span>
          </div>
          <p>{{ item.summary || '尚未填写变更摘要。' }}</p>
        </div>
        <div class="heading-meta">
          <div>
            <span>负责人</span>
            <strong>{{ item.owner }}</strong>
          </div>
          <div>
            <span>风险</span>
            <strong>{{ riskLabel(item.risk) }}</strong>
          </div>
          <div>
            <span>更新</span>
            <strong>{{ item.updatedAt | date: 'MM-dd HH:mm' }}</strong>
          </div>
        </div>
      </section>

      @if (saveError()) {
        <clr-alert clrAlertType="warning" [clrAlertClosable]="true" (clrAlertClosedChange)="dismissSaveError()">
          <clr-alert-item>
            <span class="alert-text">{{ saveError() }}</span>
          </clr-alert-item>
        </clr-alert>
      }
      @if (lastSaveError()) {
        <clr-alert clrAlertType="danger" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">
              保存失败，已恢复到最近有效执行版本：{{ lastSaveError() }}
            </span>
          </clr-alert-item>
        </clr-alert>
      }
      @if (locked()) {
        <div class="frozen-banner">
          <strong>执行版本已冻结</strong>
          <span>
            开始执行于 {{ item.frozenSnapshot?.frozenAt | date: 'yyyy-MM-dd HH:mm' }}，
            执行与复盘以冻结版本 v{{ item.frozenSnapshot?.version }} 为准；窗口、资源和会签不得修改。
          </span>
        </div>
      }

      <nav class="tab-nav" aria-label="变更详情">
        @for (tab of tabs; track tab.id) {
          <button
            type="button"
            [class.active]="selectedTab() === tab.id"
            (click)="selectedTab.set(tab.id)"
          >
            {{ tab.label }}
            @if (tab.id === 'approval' && pendingStage(); as stage) {
              <span class="nav-badge">{{ stageLabel(stage) }}</span>
            }
          </button>
        }
      </nav>

      @switch (selectedTab()) {
        @case ('overview') {
          <div class="content-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>方案概览</h2>
                  <span>影响范围、值班和执行边界</span>
                </div>
                <button
                  class="btn btn-sm"
                  type="button"
                  (click)="editing() ? cancelEdit() : beginEdit()"
                  [disabled]="locked()"
                >
                  {{ editing() ? '取消编辑' : locked() ? '方案已冻结' : '编辑方案' }}
                </button>
              </div>

              @if (editing()) {
                <div class="edit-form">
                  <clr-input-container>
                    <label>标题</label>
                    <input
                      clrInput
                      [ngModel]="draft()?.title"
                      (ngModelChange)="updateDraft('title', $event)"
                    />
                  </clr-input-container>
                  <clr-textarea-container>
                    <label>摘要</label>
                    <textarea
                      clrTextarea
                      rows="3"
                      [ngModel]="draft()?.summary"
                      (ngModelChange)="updateDraft('summary', $event)"
                    ></textarea>
                  </clr-textarea-container>
                  <div class="edit-grid">
                    <clr-input-container>
                      <label>窗口开始</label>
                      <input
                        clrInput
                        type="datetime-local"
                        [ngModel]="draft()?.window?.start"
                        (ngModelChange)="updateDraftWindow('start', $event)"
                      />
                    </clr-input-container>
                    <clr-input-container>
                      <label>窗口结束</label>
                      <input
                        clrInput
                        type="datetime-local"
                        [ngModel]="draft()?.window?.end"
                        (ngModelChange)="updateDraftWindow('end', $event)"
                      />
                    </clr-input-container>
                    <clr-input-container>
                      <label>观察窗口（分钟）</label>
                      <input
                        clrNumberInput
                        type="number"
                        [ngModel]="draft()?.window?.observationWindowMinutes"
                        (ngModelChange)="updateObservation($event)"
                      />
                    </clr-input-container>
                  </div>
                  <div class="edit-actions">
                    <button class="btn btn-primary" type="button" (click)="saveEdit()">保存方案</button>
                  </div>
                </div>
              } @else {
                <dl class="facts">
                  <div>
                    <dt>执行窗口（{{ locked() ? '冻结版本' : '当前版本' }}）</dt>
                    <dd>
                      {{ (locked() ? item.frozenSnapshot?.window.start : item.window.start) | date: 'yyyy-MM-dd HH:mm' }} 至
                      {{ (locked() ? item.frozenSnapshot?.window.end : item.window.end) | date: 'yyyy-MM-dd HH:mm' }}
                    </dd>
                  </div>
                  <div>
                    <dt>观察窗口</dt>
                    <dd>{{ (locked() ? item.frozenSnapshot?.window.observationWindowMinutes : item.window.observationWindowMinutes) }} 分钟</dd>
                  </div>
                  <div>
                    <dt>值守人员</dt>
                    <dd>{{ (locked() ? item.frozenSnapshot?.onCall.join('、') : item.onCall.join('、')) }}</dd>
                  </div>
                  <div>
                    <dt>当前门禁</dt>
                    <dd>{{ pendingStage() ? stageLabel(pendingStage()!) + '待会签' : approvalGate() }}</dd>
                  </div>
                </dl>
              }
            </section>

            <app-validation-panel [change]="item" [allChanges]="changes()" />

            <section class="surface span-2">
              <div class="surface-heading">
                <div>
                  <h2>资源清单</h2>
                  <span>{{ item.resources.length }} 个对象，明确关键资源依赖</span>
                </div>
              </div>
              <div class="resource-table">
                @for (resource of item.resources; track resource.id) {
                  <article>
                    <span class="type">{{ resourceLabel(resource.type) }}</span>
                    <div>
                      <strong>{{ resource.name }}</strong>
                      <small>{{ resource.id }}</small>
                    </div>
                    <span>{{ resource.critical ? '关键资源' : '一般资源' }}</span>
                    <span>依赖 {{ resource.dependencies.length }} 项</span>
                  </article>
                } @empty {
                  <p class="empty">未配置资源。</p>
                }
              </div>
            </section>
          </div>
        }

        @case ('dependency') {
          <section class="surface">
            <div class="surface-heading">
              <div>
                <h2>依赖关系图</h2>
                <span>虚线表示依赖资源未纳入本次影响范围</span>
              </div>
            </div>
            <app-dependency-graph [change]="item" />
          </section>
        }

        @case ('window') {
          <section class="surface">
            <div class="surface-heading">
              <div>
                <h2>窗口与资源冲突</h2>
                <span>按 09-29 至 10-02 展示所有有效窗口</span>
              </div>
            </div>
            <app-window-gantt [changes]="changes()" [selectedId]="item.id" />
            <div class="conflict-notes">
              @for (issue of issues(); track issue.id) {
                @if (issue.code === 'WINDOW_CONFLICT') {
                  <article>
                    <strong>{{ issue.title }}</strong>
                    <p>{{ issue.detail }}</p>
                    <span>{{ issue.suggestedAction }}</span>
                  </article>
                }
              } @empty {
                <p class="empty">当前没有窗口冲突。</p>
              }
            </div>
          </section>
        }

        @case ('execution') {
          <div class="content-grid execution-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>执行步骤</h2>
                  <span>
                    执行中可逐项勾选，所有操作保留时间戳
                    @if (paused()) {
                      <strong class="paused-flag">（已暂停，步骤勾选已锁定）</strong>
                    }
                  </span>
                </div>
                @if (item.status === 'approved') {
                  <button class="btn btn-primary" type="button" (click)="startExecution()">
                    开始执行（冻结方案与会签）
                  </button>
                }
              </div>
              <div class="step-list">
                @for (step of stepsBy(item); track step.id) {
                  <label class="step-row" [class.completed]="step.completed">
                    <input
                      type="checkbox"
                      [checked]="step.completed"
                      [disabled]="item.status !== 'executing' || paused()"
                      (change)="toggleStep(step.id)"
                    />
                    <span class="phase">{{ phaseLabel(step.phase) }}</span>
                    <div>
                      <strong>{{ step.title }}</strong>
                      <code>{{ step.command || '未填写命令' }}</code>
                    </div>
                    <span>{{ step.owner || '未指定' }}</span>
                  </label>
                } @empty {
                  <p class="empty">没有执行步骤。</p>
                }
              </div>
            </section>

            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>实时执行记录</h2>
                  <span>记录偏离并明确继续、暂停或回滚</span>
                </div>
                <a class="btn btn-sm" href="https://logs.example.internal/change/{{ item.id }}" target="_blank" rel="noopener">
                  打开实时日志
                </a>
              </div>
              @if (item.status === 'executing') {
                <div class="execution-controls">
                  @if (paused()) {
                    <div class="paused-strip">
                      <strong>执行已暂停</strong>
                      <span>暂停已通知共享资源上的关联变更，其未开始的会签失效；恢复后继续按冻结版本执行。</span>
                    </div>
                    <clr-textarea-container>
                      <label>继续执行说明</label>
                      <textarea
                        clrTextarea
                        rows="2"
                        [ngModel]="controlNote()"
                        (ngModelChange)="controlNote.set($event)"
                        placeholder="说明恢复依据（可留空）"
                      ></textarea>
                    </clr-textarea-container>
                    <div class="completion-actions">
                      <button class="btn" type="button" (click)="controlExecution('rollback')">
                        判定回滚
                      </button>
                      <button class="btn btn-primary" type="button" (click)="controlExecution('resume')">
                        继续执行
                      </button>
                    </div>
                  } @else {
                    <div class="deviation-form">
                      <clr-textarea-container>
                        <label>偏离 / 控制说明</label>
                        <textarea
                          clrTextarea
                          rows="3"
                          [ngModel]="deviationText()"
                          (ngModelChange)="deviationText.set($event)"
                          placeholder="描述实际执行与方案差异；选择暂停或回滚将级联通知关联变更"
                        ></textarea>
                      </clr-textarea-container>
                      <div class="deviation-actions">
                        <clr-select-container>
                          <label>处置决定</label>
                          <select
                            clrSelect
                            [ngModel]="deviationDecision()"
                            (ngModelChange)="deviationDecision.set($event)"
                          >
                            <option value="continue">继续观察</option>
                            <option value="pause">暂停执行</option>
                            <option value="rollback">立即回滚</option>
                          </select>
                        </clr-select-container>
                        <button class="btn" type="button" (click)="recordDeviation()">记录偏离</button>
                      </div>
                    </div>
                    <clr-input-container class="control-note">
                      <label>暂停/回滚原因（快捷按钮必填）</label>
                      <input
                        clrInput
                        [ngModel]="controlNote()"
                        (ngModelChange)="controlNote.set($event)"
                        placeholder="例如：核心交换机 B 平面光模块告警，暂停等待备件"
                      />
                    </clr-input-container>
                    <div class="completion-actions">
                      <button class="btn" type="button" (click)="controlExecution('rollback')" [disabled]="!controlNote().trim()">
                        判定回滚
                      </button>
                      <button class="btn" type="button" (click)="controlExecution('pause')" [disabled]="!controlNote().trim()">
                        暂停执行
                      </button>
                      <button class="btn btn-primary" type="button" (click)="complete('completed')">
                        执行完成
                      </button>
                    </div>
                  }
                </div>
              }

              <h3 class="timeline-title">执行事件</h3>
              <ol class="event-timeline">
                @for (event of item.executionEvents; track event.id) {
                  <li [class]="event.type">
                    <strong>{{ executionEventLabel(event.type) }}</strong>
                    <time>{{ event.timestamp | date: 'MM-dd HH:mm' }} · {{ event.actor }}</time>
                    <p>{{ event.note }}</p>
                  </li>
                } @empty {
                  <p class="empty">尚未开始执行。</p>
                }
              </ol>

              <h3 class="timeline-title">执行偏离</h3>
              <div class="deviation-list">
                @for (deviation of item.deviations; track deviation.id) {
                  <article>
                    <div>
                      <strong>{{ deviation.owner }}</strong>
                      <time>{{ deviation.recordedAt | date: 'MM-dd HH:mm' }}</time>
                    </div>
                    <p>{{ deviation.description }}</p>
                    <span>{{ decisionLabel(deviation.decision) }}</span>
                  </article>
                } @empty {
                  <p class="empty">尚无执行偏离。</p>
                }
              </div>
            </section>

            @if (affectedRelated().length) {
              <section class="surface span-2">
                <div class="surface-heading">
                  <div>
                    <h2>关联变更会签失效通知</h2>
                    <span>暂停或回滚后，共享资源上尚未开始的关联变更审批失效，须重新确认</span>
                  </div>
                </div>
                <div class="affected-table">
                  @for (related of affectedRelated(); track related.id) {
                    <article>
                      <div>
                        <strong>{{ related.id }} {{ related.title }}</strong>
                        <span>当前状态：{{ statusLabel(related.status) }}</span>
                      </div>
                      <ul>
                        @for (inv of related.invalidations; track inv.id) {
                          @if (inv.sourceChangeId === item.id) {
                            <li>
                              {{ stageLabel(inv.stage) }} ·
                              {{ invalidationReason(inv.reason) }} ·
                              原审批人 {{ inv.approver || '-' }} ·
                              @if (inv.reconfirmedAt) {
                                <em class="reconfirmed">
                                  已由 {{ inv.reconfirmer }} 于 {{ inv.reconfirmedAt | date: 'MM-dd HH:mm' }} 重新确认
                                </em>
                              } @else {
                                <em class="pending-reconfirm">等待重新确认</em>
                              }
                            </li>
                          }
                        }
                      </ul>
                    </article>
                  }
                </div>
              </section>
            }
          </div>
        }

        @case ('approval') {
          <div class="content-grid approval-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>顺序会签</h2>
                  <span>必须按网络、系统、安全、业务顺序完成</span>
                </div>
                @if (item.status === 'draft' || item.status === 'rejected') {
                  <button
                    class="btn btn-primary"
                    type="button"
                    (click)="submitForReview()"
                    [disabled]="hasBlockers()"
                  >
                    提交审批
                  </button>
                }
              </div>
              <ol class="approval-flow">
                @for (approval of item.approvals; track approval.stage) {
                  <li [ngClass]="approval.state">
                    <span class="flow-index">{{ $index + 1 }}</span>
                    <div>
                      <strong>
                        {{ stageLabel(approval.stage) }}
                        @if (approval.state === 'invalidated') {
                          <em class="state-flag invalidated">已失效</em>
                        }
                      </strong>
                      <p>
                        {{ approval.comment || approvalStateText(approval.state) }}
                      </p>
                      @if (approval.approver) {
                        <small>
                          {{ approval.approver }} · {{ approval.decidedAt | date: 'MM-dd HH:mm' }}
                        </small>
                      }
                    </div>
                  </li>
                }
              </ol>
            </section>

            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>会签操作</h2>
                  <span>只有当前顺位负责人可以签署</span>
                </div>
              </div>
              @if (pendingStage(); as stage) {
                @if (item.status === 'submitted' || item.status === 'rejected') {
                  <div class="approval-form">
                    <clr-input-container>
                      <label>审批人</label>
                      <input
                        clrInput
                        [ngModel]="approver()"
                        (ngModelChange)="approver.set($event)"
                      />
                    </clr-input-container>
                    <clr-textarea-container>
                      <label>意见</label>
                      <textarea
                        clrTextarea
                        rows="3"
                        [ngModel]="approvalComment()"
                        (ngModelChange)="approvalComment.set($event)"
                      ></textarea>
                    </clr-textarea-container>
                    <div class="approval-actions">
                      <button class="btn" type="button" (click)="reject(stage)">退回</button>
                      <button class="btn btn-primary" type="button" (click)="approve(stage)">
                        批准 {{ stageLabel(stage) }}
                      </button>
                    </div>
                  </div>
                } @else {
                  <p class="empty">当前状态不允许审批操作。</p>
                }
              } @else {
                <p class="approved-message">
                  会签已完成。开始执行后审批记录自动冻结，不允许修改。
                </p>
              }
            </section>

            <section class="surface span-2">
              <div class="surface-heading">
                <div>
                  <h2>审批冻结快照</h2>
                  <span>
                    @if (item.frozenSnapshot) {
                      执行与复盘以冻结版本 v{{ item.frozenSnapshot.version }} 为准（{{ item.frozenSnapshot.frozenAt | date: 'yyyy-MM-dd HH:mm' }} 冻结）
                    } @else {
                      开始执行后生成，执行与复盘以冻结版本为准
                    }
                  </span>
                </div>
              </div>
              <div class="freeze-strip">
                @for (approval of (item.frozenSnapshot?.approvals ?? item.approvals); track approval.stage) {
                  <div>
                    <span>{{ stageLabel(approval.stage) }}</span>
                    <strong>{{ approvalStateText(locked() ? 'frozen' : approval.state) }}</strong>
                    @if (approval.approver) {
                      <small>{{ approval.approver }}</small>
                    }
                  </div>
                }
              </div>
              @if (item.frozenSnapshot) {
                <dl class="facts compact">
                  <div>
                    <dt>冻结窗口</dt>
                    <dd>
                      {{ item.frozenSnapshot.window.start | date: 'yyyy-MM-dd HH:mm' }} 至
                      {{ item.frozenSnapshot.window.end | date: 'yyyy-MM-dd HH:mm' }}
                    </dd>
                  </div>
                  <div>
                    <dt>冻结资源范围</dt>
                    <dd>
                      {{ item.frozenSnapshot.resources.map((r) => r.name).join('、') || '无' }}
                    </dd>
                  </div>
                </dl>
              }
            </section>

            @if (item.invalidations.length) {
              <section class="surface span-2">
                <div class="surface-heading">
                  <div>
                    <h2>失效审批记录</h2>
                    <span>因共享资源关联变更暂停或回滚而失效，按网络、系统、安全、业务顺序重新确认</span>
                  </div>
                </div>
                <div class="invalidation-list">
                  @for (inv of item.invalidations; track inv.id) {
                    <article>
                      <strong>{{ stageLabel(inv.stage) }}</strong>
                      <span>{{ invalidationReason(inv.reason) }}（{{ inv.sourceChangeId }}）</span>
                      <small>原审批人：{{ inv.approver || '-' }} · 失效于 {{ inv.invalidatedAt | date: 'MM-dd HH:mm' }}</small>
                      @if (inv.reconfirmedAt) {
                        <em class="reconfirmed">
                          已由 {{ inv.reconfirmer }} 于 {{ inv.reconfirmedAt | date: 'MM-dd HH:mm' }} 重新确认
                        </em>
                      } @else {
                        <em class="pending-reconfirm">等待重新确认</em>
                      }
                    </article>
                  }
                </div>
              </section>
            }
          </div>
        }

        @case ('audit') {
          <div class="content-grid audit-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>审计轨迹</h2>
                  <span>创建、编辑、会签、执行和回滚均记录</span>
                </div>
                <button class="btn btn-sm" type="button" (click)="exportRetrospective()">
                  导出复盘记录
                </button>
              </div>
              <app-audit-trail [records]="item.audit" />
            </section>
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>复盘摘要</h2>
                  <span>进入正式变更档案的事实记录</span>
                </div>
              </div>
              <dl class="facts compact">
                <div>
                  <dt>最终状态</dt>
                  <dd>{{ statusLabel(item.status) }}</dd>
                </div>
                <div>
                  <dt>冻结版本</dt>
                  <dd>{{ item.frozenSnapshot ? 'v' + item.frozenSnapshot.version : '未冻结' }}</dd>
                </div>
                <div>
                  <dt>执行事件</dt>
                  <dd>{{ item.executionEvents.length }} 条（暂停/继续/回滚）</dd>
                </div>
                <div>
                  <dt>执行偏离</dt>
                  <dd>{{ item.deviations.length }} 条</dd>
                </div>
                <div>
                  <dt>失效审批</dt>
                  <dd>{{ item.invalidations.length }} 项</dd>
                </div>
                <div>
                  <dt>受影响关联变更</dt>
                  <dd>{{ affectedRelated().length }} 项</dd>
                </div>
                <div>
                  <dt>审计事件</dt>
                  <dd>{{ item.audit.length }} 条</dd>
                </div>
                <div>
                  <dt>完成步骤</dt>
                  <dd>{{ completedSteps(item) }} / {{ item.steps.length }}</dd>
                </div>
              </dl>
              <div class="retrospective-note">
                <strong>导出内容</strong>
                <p>
                  包含冻结版本与窗口、会签快照、执行事件（暂停/继续/回滚）、执行偏离、
                  失效审批与重新确认、关联变更影响和完整审计轨迹。
                </p>
              </div>
            </section>
          </div>
        }
      }
    } @else {
      <section class="not-found">
        <h1>变更不存在</h1>
        <p>该记录可能已被删除，或链接中的编号无效。</p>
        <a class="btn btn-primary" routerLink="/">返回变更队列</a>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .detail-heading {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 24px;
        padding: 20px 0 24px;
        border-bottom: 1px solid #d7d7d7;
      }

      .back-link {
        display: inline-block;
        margin-bottom: 14px;
        font-size: 12px;
      }

      .title-row {
        display: flex;
        align-items: center;
        gap: 14px;
      }

      .change-id {
        color: #266c91;
        font-size: 12px;
        font-weight: 600;
      }

      h1 {
        margin: 2px 0 0;
        font-size: 28px;
      }

      .heading-main > p {
        max-width: 760px;
        margin: 12px 0 0;
        color: #5e5e5e;
      }

      .heading-meta {
        display: grid;
        grid-template-columns: repeat(3, minmax(90px, 1fr));
        align-self: end;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      .heading-meta div {
        padding: 12px 16px;
        border-left: 1px solid #e1e1e1;
      }

      .heading-meta div:first-child {
        border-left: 0;
      }

      .heading-meta span,
      .heading-meta strong {
        display: block;
      }

      .heading-meta span {
        color: #6d6d6d;
        font-size: 11px;
      }

      .heading-meta strong {
        margin-top: 4px;
        font-size: 13px;
      }

      .status {
        padding: 3px 9px;
        border: 1px solid #9a9a9a;
        background: #f3f3f3;
        color: #474747;
        font-size: 12px;
      }

      .status.submitted,
      .status.approved {
        border-color: #5688a5;
        background: #eaf4f9;
        color: #1d5877;
      }

      .status.executing,
      .status.completed {
        border-color: #75a489;
        background: #edf7f0;
        color: #245f3d;
      }

      .status.rejected,
      .status.rolled_back {
        border-color: #d58d7e;
        background: #fbece8;
        color: #8e260f;
      }

      .tab-nav {
        display: flex;
        gap: 0;
        margin-bottom: 20px;
        border-bottom: 1px solid #d7d7d7;
        overflow-x: auto;
      }

      .tab-nav button {
        position: relative;
        padding: 13px 18px;
        border: 0;
        border-bottom: 3px solid transparent;
        background: transparent;
        color: #575757;
        cursor: pointer;
        white-space: nowrap;
      }

      .tab-nav button.active {
        border-bottom-color: #266c91;
        color: #174d6a;
        font-weight: 600;
      }

      .nav-badge {
        margin-left: 6px;
        padding: 1px 5px;
        background: #eaf4f9;
        color: #215a78;
        font-size: 10px;
      }

      .content-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .surface {
        padding: 18px;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      .span-2 {
        grid-column: 1 / -1;
      }

      .surface-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding-bottom: 14px;
        border-bottom: 1px solid #e3e3e3;
      }

      .surface-heading h2 {
        margin: 0;
        font-size: 17px;
      }

      .surface-heading span {
        color: #666;
        font-size: 12px;
      }

      .facts {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 1px;
        margin: 18px 0 0;
        background: #e1e1e1;
      }

      .facts div {
        padding: 14px;
        background: #fafafa;
      }

      .facts dt {
        color: #666;
        font-size: 12px;
      }

      .facts dd {
        margin: 5px 0 0;
        font-weight: 600;
      }

      .facts.compact {
        margin-top: 16px;
      }

      .edit-form {
        padding-top: 18px;
      }

      .edit-grid,
      .deviation-actions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }

      .edit-actions,
      .completion-actions,
      .approval-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 16px;
      }

      .resource-table article {
        display: grid;
        grid-template-columns: 80px minmax(180px, 1fr) 100px 120px;
        align-items: center;
        gap: 14px;
        padding: 12px 4px;
        border-bottom: 1px solid #e6e6e6;
      }

      .resource-table article:last-child {
        border-bottom: 0;
      }

      .resource-table article div {
        display: flex;
        flex-direction: column;
      }

      .resource-table small,
      .resource-table article > span:last-child {
        color: #6b6b6b;
        font-size: 11px;
      }

      .type,
      .phase {
        display: inline-block;
        width: fit-content;
        padding: 2px 7px;
        background: #edf3f6;
        color: #205d7e;
        font-size: 11px;
      }

      .conflict-notes {
        margin-top: 16px;
      }

      .conflict-notes article {
        padding: 14px;
        border-left: 3px solid #c21d00;
        background: #fbece8;
      }

      .conflict-notes p {
        margin: 6px 0;
      }

      .conflict-notes span {
        color: #8e260f;
        font-size: 12px;
      }

      .step-row {
        display: grid;
        grid-template-columns: 20px 50px 1fr 90px;
        align-items: center;
        gap: 12px;
        padding: 14px 2px;
        border-bottom: 1px solid #e6e6e6;
      }

      .step-row.completed {
        background: #f5faf6;
      }

      .step-row div {
        display: flex;
        flex-direction: column;
      }

      .step-row code {
        margin-top: 4px;
        color: #666;
        font-size: 11px;
      }

      .deviation-form {
        padding: 16px 0;
        border-bottom: 1px solid #e3e3e3;
      }

      .deviation-actions {
        grid-template-columns: 1fr auto;
        align-items: end;
      }

      .deviation-list article {
        padding: 12px 0;
        border-bottom: 1px solid #e6e6e6;
      }

      .deviation-list article > div {
        display: flex;
        justify-content: space-between;
      }

      .deviation-list p {
        margin: 7px 0;
      }

      .deviation-list span {
        color: #8e260f;
        font-size: 11px;
      }

      .approval-flow {
        margin: 18px 0 0;
        padding: 0;
        list-style: none;
      }

      .approval-flow li {
        display: grid;
        grid-template-columns: 32px 1fr;
        gap: 12px;
        padding: 12px 0;
        border-bottom: 1px solid #e6e6e6;
      }

      .flow-index {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border: 1px solid #9d9d9d;
        color: #555;
      }

      .approval-flow li.approved .flow-index {
        border-color: #4b8d65;
        background: #e8f5ed;
        color: #245f3d;
      }

      .approval-flow li.rejected .flow-index {
        border-color: #c21d00;
        background: #fbece8;
        color: #8e260f;
      }

      .approval-flow p {
        margin: 5px 0;
        color: #5f5f5f;
      }

      .approval-flow small {
        color: #737373;
      }

      .approval-form {
        padding-top: 16px;
      }

      .approved-message {
        margin: 18px 0 0;
        padding: 16px;
        border-left: 3px solid #4b8d65;
        background: #edf7f0;
        color: #245f3d;
      }

      .freeze-strip {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1px;
        margin-top: 18px;
        background: #d7d7d7;
      }

      .freeze-strip div {
        display: flex;
        flex-direction: column;
        padding: 14px;
        background: #fafafa;
      }

      .freeze-strip span {
        color: #666;
        font-size: 11px;
      }

      .freeze-strip strong {
        margin-top: 4px;
      }

      .retrospective-note {
        margin-top: 18px;
        padding: 16px;
        background: #f4f6f7;
      }

      .retrospective-note p {
        margin: 6px 0 0;
        color: #5f5f5f;
      }

      .frozen-banner {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin: 16px 0;
        padding: 12px 16px;
        border-left: 3px solid #4b8d65;
        background: #edf7f0;
        color: #245f3d;
      }

      .frozen-banner span {
        font-size: 12px;
      }

      .paused-flag {
        color: #8e260f;
      }

      .paused-strip {
        margin-bottom: 12px;
        padding: 12px 14px;
        border-left: 3px solid #d0a251;
        background: #fff7e6;
      }

      .paused-strip span {
        display: block;
        margin-top: 4px;
        color: #7c5000;
        font-size: 12px;
      }

      .execution-controls {
        padding-bottom: 12px;
        border-bottom: 1px solid #e3e3e3;
      }

      .control-note {
        margin-top: 8px;
      }

      .timeline-title {
        margin: 18px 0 8px;
        font-size: 14px;
      }

      .event-timeline {
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .event-timeline li {
        padding: 10px 0 10px 14px;
        border-left: 2px solid #cfd8de;
      }

      .event-timeline li.pause {
        border-left-color: #d0a251;
      }

      .event-timeline li.rollback {
        border-left-color: #c21d00;
      }

      .event-timeline li.resume {
        border-left-color: #4b8d65;
      }

      .event-timeline li.complete {
        border-left-color: #4b8d65;
      }

      .event-timeline time {
        margin-left: 8px;
        color: #737373;
        font-size: 11px;
      }

      .event-timeline p {
        margin: 4px 0 0;
        color: #5f5f5f;
        font-size: 12px;
      }

      .approval-flow li.invalidated .flow-index {
        border-color: #d0a251;
        background: #fff7e6;
        color: #7c5000;
      }

      .approval-flow li.frozen .flow-index {
        border-color: #4b8d65;
        background: #e8f5ed;
        color: #245f3d;
      }

      .state-flag.invalidated {
        margin-left: 8px;
        padding: 1px 6px;
        background: #fff7e6;
        color: #7c5000;
        font-size: 11px;
        font-style: normal;
      }

      .freeze-strip small {
        margin-top: 3px;
        color: #737373;
        font-size: 10px;
      }

      .invalidation-list article {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        padding: 10px 0;
        border-bottom: 1px solid #e6e6e6;
        font-size: 13px;
      }

      .invalidation-list article:last-child {
        border-bottom: 0;
      }

      .invalidation-list span {
        color: #7c5000;
      }

      .invalidation-list small {
        color: #737373;
      }

      .reconfirmed {
        color: #245f3d;
        font-style: normal;
      }

      .pending-reconfirm {
        color: #8e260f;
        font-style: normal;
      }

      .affected-table article {
        padding: 12px 0;
        border-bottom: 1px solid #e6e6e6;
      }

      .affected-table article:last-child {
        border-bottom: 0;
      }

      .affected-table article > div {
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }

      .affected-table article > div span {
        color: #7c5000;
        font-size: 12px;
      }

      .affected-table ul {
        margin: 8px 0 0;
        padding-left: 18px;
        color: #5f5f5f;
        font-size: 12px;
      }

      .empty {
        color: #737373;
      }

      .not-found {
        margin-top: 50px;
        padding: 48px;
        text-align: center;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      @media (max-width: 1100px) {
        .detail-heading,
        .content-grid {
          grid-template-columns: 1fr;
        }

        .span-2 {
          grid-column: auto;
        }
      }

      @media (max-width: 700px) {
        .heading-meta,
        .facts,
        .edit-grid,
        .freeze-strip {
          grid-template-columns: 1fr;
        }

        .heading-meta div {
          border-left: 0;
          border-top: 1px solid #e1e1e1;
        }

        .resource-table article,
        .step-row {
          grid-template-columns: 1fr;
        }

        .tab-nav {
          padding-bottom: 4px;
        }
      }
    `,
  ],
})
export class ChangeDetailComponent {
  private readonly store = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly service = inject(ChangeRequestService);
  private readonly changeId = this.route.snapshot.paramMap.get('id') ?? '';

  readonly changes = this.store.selectSignal(selectAllChanges);
  readonly change = computed(() => this.changes().find((item) => item.id === this.changeId));
  readonly saveError = this.store.selectSignal(selectSaveErrorFor(this.changeId));
  readonly lastSaveError = this.store.selectSignal(selectLastSaveError);
  readonly affectedRelated = this.store.selectSignal(
    selectAffectedRelatedChanges(this.changeId),
  );
  readonly selectedTab = signal<DetailTab>('overview');
  readonly editing = signal(false);
  /** 开始编辑时读到的版本号，保存时做乐观并发校验。 */
  readonly baseVersion = signal(1);
  readonly draft = signal<ChangeRequest | null>(null);
  readonly approver = signal('');
  readonly approvalComment = signal('');
  readonly deviationText = signal('');
  readonly deviationDecision = signal<DeviationRecord['decision']>('continue');
  readonly controlNote = signal('');

  readonly tabs: Array<{ id: DetailTab; label: string }> = [
    { id: 'overview', label: '方案概览' },
    { id: 'dependency', label: '依赖关系' },
    { id: 'window', label: '窗口甘特' },
    { id: 'execution', label: '执行记录' },
    { id: 'approval', label: '审批会签' },
    { id: 'audit', label: '审计复盘' },
  ];

  readonly issues = computed(() => {
    const item = this.change();
    return item ? validateChange(item, this.changes()) : [];
  });

  readonly hasBlockers = computed(() =>
    this.issues().some((issue) => issue.severity === 'blocker'),
  );

  readonly pendingStage = computed<ApprovalStage | null>(() => {
    const item = this.change();
    if (!item || !['submitted', 'rejected'].includes(item.status)) {
      return null;
    }
    const rejected = item.approvals.find((approval) => approval.state === 'rejected');
    if (rejected) {
      return rejected.stage;
    }
    return (
      item.approvals.find(
        (approval) => approval.state === 'pending' || approval.state === 'invalidated',
      )?.stage ?? null
    );
  });

  readonly locked = computed(() => {
    const item = this.change();
    return item ? isExecutionLocked(item) : false;
  });

  readonly paused = computed(() => {
    const item = this.change();
    return item ? isExecutionPaused(item) : false;
  });

  beginEdit(): void {
    const item = this.change();
    if (!item || isExecutionLocked(item)) {
      return;
    }
    this.draft.set(structuredClone(item));
    this.baseVersion.set(item.version);
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.draft.set(null);
    this.dismissSaveError();
  }

  updateDraft<K extends keyof ChangeRequest>(key: K, value: ChangeRequest[K]): void {
    this.draft.update((draft) => (draft ? { ...draft, [key]: value } : draft));
  }

  updateDraftWindow(key: 'start' | 'end', value: string): void {
    this.draft.update((draft) =>
      draft ? { ...draft, window: { ...draft.window, [key]: value } } : draft,
    );
  }

  updateObservation(value: string | number): void {
    this.draft.update((draft) =>
      draft
        ? {
            ...draft,
            window: { ...draft.window, observationWindowMinutes: Number(value) || 0 },
          }
        : draft,
    );
  }

  saveEdit(): void {
    const draft = this.draft();
    if (!draft) {
      return;
    }
    // 冻结后或版本过期时 reducer 会拒绝并写 saveErrors，页面立即恢复为最近有效版本
    this.store.dispatch(
      ChangeRequestActions.updateChange({ change: draft, baseVersion: this.baseVersion() }),
    );
    this.editing.set(false);
    this.draft.set(null);
  }

  dismissSaveError(): void {
    this.store.dispatch(ChangeRequestActions.clearSaveError({ id: this.changeId }));
  }

  submitForReview(): void {
    if (!this.hasBlockers()) {
      this.store.dispatch(ChangeRequestActions.submitForReview({ id: this.changeId }));
    }
  }

  approve(stage: ApprovalStage): void {
    const approver = this.approver().trim() || '当前用户';
    const comment = this.approvalComment().trim() || '同意按方案执行。';
    this.store.dispatch(
      ChangeRequestActions.approveStage({
        id: this.changeId,
        stage,
        approver,
        comment,
      }),
    );
    this.clearApprovalForm();
  }

  reject(stage: ApprovalStage): void {
    const approver = this.approver().trim() || '当前用户';
    const comment = this.approvalComment().trim();
    if (!comment) {
      return;
    }
    this.store.dispatch(
      ChangeRequestActions.rejectStage({
        id: this.changeId,
        stage,
        approver,
        comment,
      }),
    );
    this.clearApprovalForm();
  }

  startExecution(): void {
    this.store.dispatch(ChangeRequestActions.startExecution({ id: this.changeId }));
  }

  controlExecution(control: ExecutionControl): void {
    const note = this.controlNote().trim();
    if (control !== 'resume' && !note) {
      return;
    }
    this.store.dispatch(ChangeRequestActions.controlExecution({ id: this.changeId, control, note }));
    this.controlNote.set('');
  }

  toggleStep(stepId: string): void {
    if (this.paused()) {
      return;
    }
    this.store.dispatch(ChangeRequestActions.toggleStep({ id: this.changeId, stepId }));
  }

  recordDeviation(): void {
    const description = this.deviationText().trim();
    if (!description) {
      return;
    }
    const deviation: DeviationRecord = {
      id: `dev-${Date.now()}`,
      recordedAt: new Date().toISOString(),
      owner: this.change()?.onCall[0] ?? '当前用户',
      description,
      decision: this.deviationDecision(),
    };
    this.store.dispatch(ChangeRequestActions.recordDeviation({ id: this.changeId, deviation }));
    this.deviationText.set('');
  }

  complete(result: 'completed' | 'rolled_back'): void {
    const note =
      result === 'completed'
        ? '观察窗口内指标稳定，变更完成。'
        : '发现不可接受影响，按方案完成回滚。';
    this.store.dispatch(ChangeRequestActions.completeExecution({ id: this.changeId, result, note }));
  }

  exportRetrospective(): void {
    const item = this.change();
    if (!item) {
      return;
    }
    const blob = new Blob([this.service.exportRetrospective(item, this.changes())], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${item.id}-retrospective.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  stepsBy(change: ChangeRequest): ChangeStep[] {
    const order: ChangeStep['phase'][] = ['prepare', 'execute', 'verify', 'rollback'];
    return [...change.steps].sort((left, right) => {
      const phase = order.indexOf(left.phase) - order.indexOf(right.phase);
      return phase || left.id.localeCompare(right.id);
    });
  }

  completedSteps(change: ChangeRequest): number {
    return change.steps.filter((step) => step.completed).length;
  }

  statusLabel(status: ChangeRequest['status']): string {
    return STATUS_LABELS[status];
  }

  riskLabel(risk: ChangeRequest['risk']): string {
    return RISK_LABELS[risk];
  }

  resourceLabel(type: ChangeRequest['resources'][number]['type']): string {
    return RESOURCE_LABELS[type];
  }

  stageLabel(stage: ApprovalStage): string {
    return STAGE_LABELS[stage];
  }

  phaseLabel(phase: ChangeStep['phase']): string {
    return PHASE_LABELS[phase];
  }

  approvalStateText(state: ChangeRequest['approvals'][number]['state']): string {
    return {
      pending: '等待签署',
      approved: '已批准',
      rejected: '已退回',
      frozen: '已冻结',
      invalidated: '已失效，需重新确认',
    }[state];
  }

  executionEventLabel(type: ExecutionEventRecord['type']): string {
    return EXECUTION_EVENT_LABELS[type];
  }

  invalidationReason(reason: 'paused' | 'rolled_back'): string {
    return reason === 'paused' ? '关联变更暂停' : '关联变更回滚';
  }

  approvalGate(): string {
    const item = this.change();
    if (!item) {
      return '-';
    }
    if (item.status === 'approved') {
      return '已批准，等待执行';
    }
    if (['executing', 'completed', 'rolled_back'].includes(item.status)) {
      return '审批已冻结';
    }
    return '方案草稿';
  }

  decisionLabel(decision: DeviationRecord['decision']): string {
    return {
      continue: '继续观察',
      pause: '暂停执行',
      rollback: '立即回滚',
    }[decision];
  }

  private clearApprovalForm(): void {
    this.approver.set('');
    this.approvalComment.set('');
  }
}

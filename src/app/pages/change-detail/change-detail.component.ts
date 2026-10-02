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
  ApprovalRecord,
  ApprovalStage,
  ChangeRequest,
  ChangeStep,
  DECISION_LABELS,
  DeviationDecision,
  PHASE_LABELS,
  RESOURCE_LABELS,
  RISK_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  activeApprovals,
  causedInvalidations,
  invalidatedApprovals,
  isExecutionFrozen,
  nextPendingStage,
  validateChange,
} from '../../models/change-request.model';
import { ChangeRequestService } from '../../services/change-request.service';
import { ChangeRequestActions } from '../../store/change-request.actions';
import {
  selectAllChanges,
  selectSaveConflictById,
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
      @if (saveConflict(); as conflict) {
        <clr-alert clrAlertType="warning" [clrAlertClosable]="true" (clrAlertClosedChange)="dismissConflict()">
          <clr-alert-item>
            <span class="alert-text">
              {{ conflict.reason === 'frozen' ? '执行版本已冻结，保存被拒绝' : '保存失败：另一个窗口已保存更新版本' }}
              （当前有效版本 v{{ conflict.currentVersion }}
              @if (conflict.attemptedVersion !== undefined) {
                ，本次基线 v{{ conflict.attemptedVersion }}
              }）。
              <button class="btn btn-sm btn-warning-outline" type="button" (click)="recoverFromConflict()">
                放弃编辑并恢复最近有效执行版本
              </button>
            </span>
          </clr-alert-item>
        </clr-alert>
      }

      <section class="detail-heading">
        <div class="heading-main">
          <a routerLink="/" class="back-link">返回变更队列</a>
          <div class="title-row">
            <div>
              <span class="change-id">{{ item.id }}</span>
              <h1>{{ item.title }}</h1>
            </div>
            <span class="status" [class]="item.status">{{ statusLabel(item.status) }}</span>
            <span class="version-tag">v{{ item.version }}</span>
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
                  [disabled]="frozen()"
                >
                  {{ editing() ? '取消编辑' : frozen() ? '执行版本已冻结' : '编辑方案' }}
                </button>
              </div>

              @if (frozen(); as snapshot) {
                <div class="frozen-banner">
                  <strong>执行版本已冻结（v{{ snapshot.version }}，{{ snapshot.frozenAt | date: 'yyyy-MM-dd HH:mm' }} 冻结）</strong>
                  <p>执行开始时方案和会签已固化，概览、执行和复盘一律以冻结版本为准；窗口和资源不允许再修改。</p>
                </div>
              }

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
                    <dt>执行窗口</dt>
                    <dd>
                      @if (frozen()) {
                        <span class="frozen-note">{{ frozenWindow(item).start | date: 'yyyy-MM-dd HH:mm' }} 至
                        {{ frozenWindow(item).end | date: 'yyyy-MM-dd HH:mm' }}
                        <small>（冻结版本）</small></span>
                      } @else {
                        {{ item.window.start | date: 'yyyy-MM-dd HH:mm' }} 至
                        {{ item.window.end | date: 'yyyy-MM-dd HH:mm' }}
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>观察窗口</dt>
                    <dd>{{ frozenWindow(item).observationWindowMinutes }} 分钟</dd>
                  </div>
                  <div>
                    <dt>值守人员</dt>
                    <dd>{{ item.onCall.join('、') }}</dd>
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
                  <span>{{ (frozen()?.resources.length ?? item.resources.length) }} 个对象，明确关键资源依赖</span>
                </div>
              </div>
              <div class="resource-table">
                @for (resource of (frozen()?.resources ?? item.resources); track resource.id) {
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
                <span>虚线表示依赖资源未纳入本次影响范围；执行中以冻结版本为准</span>
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
            @if (frozen()) {
              <div class="frozen-banner compact">
                冻结窗口：{{ frozenWindow(item).start | date: 'yyyy-MM-dd HH:mm' }} 至
                {{ frozenWindow(item).end | date: 'yyyy-MM-dd HH:mm' }}。
                其他页面修改窗口不会影响执行版本。
              </div>
            }
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
                  <span>执行中可逐项勾选，所有操作保留时间戳</span>
                </div>
                @if (item.status === 'approved') {
                  <button class="btn btn-primary" type="button" (click)="startExecution()">
                    开始执行并冻结版本
                  </button>
                }
                @if (item.status === 'paused') {
                  <span class="status paused">执行已暂停 · 步骤锁定</span>
                }
              </div>
              @if (frozen()) {
                <p class="frozen-note">步骤来自冻结执行版本 v{{ item.executionSnapshot?.version }}。</p>
              }
              <div class="step-list">
                @for (step of stepsBy(item); track step.id) {
                  <label class="step-row" [class.completed]="step.completed">
                    <input
                      type="checkbox"
                      [checked]="step.completed"
                      [disabled]="item.status !== 'executing'"
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
                  <span>记录处置决定并明确继续、暂停或回滚</span>
                </div>
                <a class="btn btn-sm" href="https://logs.example.internal/change/{{ item.id }}" target="_blank" rel="noopener">
                  打开实时日志
                </a>
              </div>
              @if (item.status === 'executing' || item.status === 'paused') {
                <div class="deviation-form">
                  <clr-textarea-container>
                    <label>处置说明</label>
                    <textarea
                      clrTextarea
                      rows="3"
                      [ngModel]="deviationText()"
                      (ngModelChange)="deviationText.set($event)"
                      [placeholder]="item.status === 'paused' ? '说明恢复条件或回滚依据' : '描述实际执行与方案差异'"
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
                        @if (item.status === 'executing') {
                          <option value="continue">继续观察</option>
                          <option value="pause">暂停执行</option>
                          <option value="rollback">立即回滚</option>
                        } @else {
                          <option value="resume">继续执行</option>
                          <option value="rollback">立即回滚</option>
                        }
                      </select>
                    </clr-select-container>
                    <button class="btn" type="button" (click)="recordDecision()">
                      {{ decisionButtonLabel() }}
                    </button>
                  </div>
                  @if (deviationDecision() === 'pause' || deviationDecision() === 'rollback') {
                    <p class="cascade-hint">
                      记录后，共享资源上尚未开始的关联变更审批将失效，需重新会签确认。
                    </p>
                  }
                </div>
                <div class="completion-actions">
                  <button class="btn" type="button" (click)="complete('rolled_back')">判定回滚</button>
                  <button class="btn btn-primary" type="button" (click)="complete('completed')">
                    执行完成
                  </button>
                </div>
              }
              <div class="deviation-list">
                @for (deviation of item.deviations; track deviation.id) {
                  <article [class.pause-decision]="deviation.decision === 'pause'">
                    <div>
                      <strong>{{ deviation.owner }}</strong>
                      <time>{{ deviation.recordedAt | date: 'MM-dd HH:mm' }}</time>
                    </div>
                    <p>{{ deviation.description }}</p>
                    <span [class]="'decision-' + deviation.decision">{{ decisionLabel(deviation.decision) }}</span>
                  </article>
                } @empty {
                  <p class="empty">尚无执行偏离。</p>
                }
              </div>

              @if (cascadedChanges().length) {
                <div class="cascade-panel">
                  <h3>本变更暂停/回滚导致审批失效的关联变更</h3>
                  <ul>
                    @for (related of cascadedChanges(); track related.id) {
                      <li>
                        <a [routerLink]="['/changes', related.id]">{{ related.id }} {{ related.title }}</a>
                        <span>失效节点：{{ invalidatedStageLabels(related) || '全部会签' }}</span>
                      </li>
                    }
                  </ul>
                </div>
              }
            </section>
          </div>
        }

        @case ('approval') {
          <div class="content-grid approval-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>顺序会签</h2>
                  <span>必须按网络、系统、安全、业务顺序完成；以当前有效轮次为准</span>
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

              @if (historyApprovals().length) {
                <div class="round-history">
                  <h3>已失效的历史会签（不再有效）</h3>
                  <ol class="approval-flow invalidated">
                    @for (approval of historyApprovals(); track approval.stage + '-' + approval.round) {
                      <li [ngClass]="approval.state">
                        <span class="flow-index">{{ approval.round }}</span>
                        <div>
                          <strong>{{ stageLabel(approval.stage) }} · 第 {{ approval.round }} 轮</strong>
                          <p>{{ approval.invalidatedReason || '因关联变更暂停或回滚失效' }}</p>
                          <small>
                            触发变更 {{ approval.invalidatedByChangeId }} ·
                            {{ approval.invalidatedAt | date: 'MM-dd HH:mm' }}
                          </small>
                        </div>
                      </li>
                    }
                  </ol>
                </div>
              }

              <ol class="approval-flow">
                @for (approval of activeFlow(); track approval.stage) {
                  <li [ngClass]="approval.state">
                    <span class="flow-index">{{ $index + 1 }}</span>
                    <div>
                      <strong>{{ stageLabel(approval.stage) }}</strong>
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
                  <span>只有当前有效轮次的当前顺位负责人可以签署</span>
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
              } @else if (frozen()) {
                <p class="approved-message">
                  会签已随执行开始冻结，以下冻结快照是唯一有效批准，交接时无需再辨认历史审批。
                </p>
              } @else {
                <p class="approved-message">会签已完成，等待开始执行冻结。</p>
              }
            </section>

            <section class="surface span-2">
              <div class="surface-heading">
                <div>
                  <h2>审批冻结快照</h2>
                  <span>执行与复盘以冻结版本为准</span>
                </div>
              </div>
              @if (frozen()) {
                <p class="frozen-note">
                  冻结于 {{ item.executionSnapshot?.frozenAt | date: 'yyyy-MM-dd HH:mm' }}，
                  执行版本 v{{ item.executionSnapshot?.version }}。执行开始后审批页不能再修改窗口或会签。
                </p>
              }
              <div class="freeze-strip">
                @for (approval of freezeStrip(); track approval.stage + '-' + approval.round) {
                  <div>
                    <span>{{ stageLabel(approval.stage) }}</span>
                    <strong>{{ approvalStateText(approval.state) }}</strong>
                    @if (approval.approver) {
                      <small>{{ approval.approver }}</small>
                    }
                  </div>
                }
              </div>
            </section>
          </div>
        }

        @case ('audit') {
          <div class="content-grid audit-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>审计轨迹</h2>
                  <span>创建、编辑、会签、冻结、暂停、继续和回滚均记录</span>
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
                  <dt>执行版本</dt>
                  <dd>v{{ frozen()?.version ?? item.version }}{{ frozen() ? '（已冻结）' : '' }}</dd>
                </div>
                <div>
                  <dt>执行过程记录</dt>
                  <dd>{{ item.deviations.length }} 条（暂停/继续/回滚）</dd>
                </div>
                <div>
                  <dt>审计事件</dt>
                  <dd>{{ item.audit.length }} 条</dd>
                </div>
                <div>
                  <dt>完成步骤</dt>
                  <dd>{{ completedSteps(item) }} / {{ (frozen()?.steps.length ?? item.steps.length) }}</dd>
                </div>
                <div>
                  <dt>失效审批</dt>
                  <dd>{{ historyApprovals().length }} 个节点</dd>
                </div>
              </dl>

              <div class="retro-block">
                <h3>本变更的失效审批</h3>
                @if (historyApprovals().length) {
                  <ul class="retro-list">
                    @for (approval of historyApprovals(); track approval.stage + '-' + approval.round) {
                      <li>
                        第 {{ approval.round }} 轮 {{ stageLabel(approval.stage) }}：
                        {{ approval.invalidatedReason || '关联变更暂停或回滚' }}，
                        触发变更 {{ approval.invalidatedByChangeId }}
                        （{{ approval.invalidatedAt | date: 'MM-dd HH:mm' }}）
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="empty">无失效审批。</p>
                }
              </div>

              <div class="retro-block">
                <h3>受影响的关联变更</h3>
                @if (cascadedChanges().length) {
                  <ul class="retro-list">
                    @for (related of cascadedChanges(); track related.id) {
                      <li>
                        <a [routerLink]="['/changes', related.id]">{{ related.id }} {{ related.title }}</a>：
                        共享资源 {{ sharedResourceNames(related) }}，失效节点
                        {{ invalidatedStageLabels(related) || '全部会签' }}，需重新确认。
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="empty">无关联变更受影响。</p>
                }
              </div>

              <div class="retrospective-note">
                <strong>导出内容</strong>
                <p>包含冻结方案与会签快照、执行窗口、暂停/继续/回滚过程、失效审批、受影响关联变更和完整审计轨迹。</p>
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

      .version-tag {
        padding: 2px 8px;
        background: #eef3f6;
        color: #205d7e;
        font-size: 11px;
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

      .status.paused {
        border-color: #d0a251;
        background: #fff7e6;
        color: #7c5000;
      }

      .status.rejected,
      .status.rolled_back {
        border-color: #d58d7e;
        background: #fbece8;
        color: #8e260f;
      }

      .frozen-banner {
        margin-top: 16px;
        padding: 14px 16px;
        border-left: 3px solid #205d7e;
        background: #eaf4f9;
      }

      .frozen-banner.compact {
        margin: 14px 0 0;
        font-size: 12px;
        color: #1d5877;
      }

      .frozen-banner p {
        margin: 6px 0 0;
        color: #355a6e;
        font-size: 12px;
      }

      .frozen-note {
        margin: 10px 0;
        color: #205d7e;
        font-size: 12px;
      }

      .frozen-note small {
        color: #5b7f93;
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

      .cascade-hint {
        margin: 10px 0 0;
        padding: 10px 12px;
        background: #fff7e6;
        color: #7c5000;
        font-size: 12px;
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
        display: inline-block;
        width: fit-content;
        padding: 2px 7px;
        font-size: 11px;
        background: #edf3f6;
        color: #205d7e;
      }

      .deviation-list span.decision-pause,
      .deviation-list span.decision-rollback {
        background: #fbece8;
        color: #8e260f;
      }

      .deviation-list span.decision-resume {
        background: #edf7f0;
        color: #245f3d;
      }

      .cascade-panel {
        margin-top: 16px;
        padding: 14px;
        background: #faf7f2;
        border-left: 3px solid #d0a251;
      }

      .cascade-panel h3 {
        margin: 0 0 8px;
        font-size: 13px;
      }

      .cascade-panel ul,
      .retro-list {
        margin: 0;
        padding-left: 18px;
      }

      .cascade-panel li {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px 0;
        font-size: 12px;
      }

      .cascade-panel span {
        color: #7c5000;
      }

      .round-history {
        margin: 16px 0 8px;
        padding: 12px 14px;
        background: #faf3f1;
      }

      .round-history h3 {
        margin: 0 0 8px;
        font-size: 13px;
        color: #8e260f;
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

      .approval-flow.invalidated li {
        opacity: 0.85;
      }

      .approval-flow li.invalidated .flow-index {
        border-color: #b98a7e;
        background: #f6e6e1;
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

      .freeze-strip small {
        color: #737373;
        font-size: 11px;
      }

      .retro-block {
        margin-top: 18px;
      }

      .retro-block h3 {
        margin: 0 0 8px;
        font-size: 14px;
      }

      .retro-list li {
        padding: 5px 0;
        color: #4c4c4c;
        font-size: 13px;
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
  readonly saveConflict = this.store.selectSignal(selectSaveConflictById(this.changeId));
  readonly selectedTab = signal<DetailTab>('overview');
  readonly editing = signal(false);
  readonly draft = signal<ChangeRequest | null>(null);
  /** 编辑器打开时的基线版本；保存时携带，用于拒绝过期覆盖。 */
  readonly editBaseVersion = signal<number | null>(null);
  readonly approver = signal('');
  readonly approvalComment = signal('');
  readonly deviationText = signal('');
  readonly deviationDecision = signal<DeviationDecision>('continue');

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

  readonly frozen = computed(() => this.change()?.executionSnapshot ?? null);

  readonly pendingStage = computed<ApprovalStage | null>(() => {
    const item = this.change();
    return item ? nextPendingStage(item) : null;
  });

  readonly activeFlow = computed<ApprovalRecord[]>(() => {
    const item = this.change();
    return item ? activeApprovals(item) : [];
  });

  readonly historyApprovals = computed<ApprovalRecord[]>(() => {
    const item = this.change();
    return item ? invalidatedApprovals(item) : [];
  });

  readonly cascadedChanges = computed<ChangeRequest[]>(() => {
    const item = this.change();
    return item ? causedInvalidations(item, this.changes()) : [];
  });

  readonly freezeStrip = computed<ApprovalRecord[]>(() => {
    const item = this.change();
    if (!item) {
      return [];
    }
    if (item.executionSnapshot) {
      return item.executionSnapshot.approvals;
    }
    return activeApprovals(item);
  });

  beginEdit(): void {
    const item = this.change();
    if (!item || isExecutionFrozen(item)) {
      return;
    }
    this.draft.set(structuredClone(item));
    this.editBaseVersion.set(item.version);
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.draft.set(null);
    this.editBaseVersion.set(null);
  }

  /** 保存失败/发现过期后，放弃旧草稿，以最近有效执行版本重新进入编辑。 */
  recoverFromConflict(): void {
    const item = this.change();
    if (!item) {
      return;
    }
    this.store.dispatch(ChangeRequestActions.dismissSaveConflict({ id: this.changeId }));
    this.draft.set(null);
    this.editBaseVersion.set(null);
    this.editing.set(false);
    if (!isExecutionFrozen(item)) {
      this.draft.set(structuredClone(item));
      this.editBaseVersion.set(item.version);
      this.editing.set(true);
    }
  }

  dismissConflict(): void {
    this.store.dispatch(ChangeRequestActions.dismissSaveConflict({ id: this.changeId }));
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
    const baseVersion = this.editBaseVersion();
    const item = this.change();
    if (!draft || baseVersion === null || !item) {
      return;
    }
    // 执行版本冻结后，旧页面保存一律拒绝，不允许覆盖冻结版本。
    if (isExecutionFrozen(item)) {
      this.recoverFromConflict();
      return;
    }
    this.store.dispatch(
      ChangeRequestActions.updateChange({ change: draft, baseVersion }),
    );
    // 若版本不匹配（旧页面），store 保留最近有效版本并给出对账提示；编辑态保留以便重试或恢复。
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
      ChangeRequestActions.approveStage({ id: this.changeId, stage, approver, comment }),
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
      ChangeRequestActions.rejectStage({ id: this.changeId, stage, approver, comment }),
    );
    this.clearApprovalForm();
  }

  startExecution(): void {
    this.store.dispatch(ChangeRequestActions.startExecution({ id: this.changeId }));
  }

  toggleStep(stepId: string): void {
    this.store.dispatch(ChangeRequestActions.toggleStep({ id: this.changeId, stepId }));
  }

  decisionButtonLabel(): string {
    const decision = this.deviationDecision();
    return decision === 'pause'
      ? '记录暂停并失效关联审批'
      : decision === 'rollback'
        ? '记录回滚并失效关联审批'
        : decision === 'resume'
          ? '继续执行'
          : '记录继续观察';
  }

  recordDecision(): void {
    const item = this.change();
    if (!item) {
      return;
    }
    const description = this.deviationText().trim();
    if (!description) {
      return;
    }
    const eventId = `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    this.store.dispatch(
      ChangeRequestActions.recordExecutionDecision({
        id: this.changeId,
        owner: item.onCall[0] ?? item.owner ?? '当前用户',
        description,
        decision: this.deviationDecision(),
        eventId,
      }),
    );
    this.deviationText.set('');
    this.deviationDecision.set(
      item.status === 'paused' ? 'resume' : 'continue',
    );
  }

  complete(result: 'completed' | 'rolled_back'): void {
    const note =
      result === 'completed'
        ? '观察窗口内指标稳定，变更完成。'
        : '发现不可接受影响，按冻结方案完成回滚。';
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
    const source = change.executionSnapshot?.steps ?? change.steps;
    const order: ChangeStep['phase'][] = ['prepare', 'execute', 'verify', 'rollback'];
    return [...source].sort((left, right) => {
      const phase = order.indexOf(left.phase) - order.indexOf(right.phase);
      return phase || left.id.localeCompare(right.id);
    });
  }

  frozenWindow(change: ChangeRequest): ChangeRequest['window'] {
    return change.executionSnapshot?.window ?? change.window;
  }

  sharedResourceNames(related: ChangeRequest): string {
    const item = this.change();
    if (!item) {
      return related.resources.map((resource) => resource.name).join('、');
    }
    return related.resources
      .filter((resource) => item.resources.some((owned) => owned.id === resource.id))
      .map((resource) => resource.name)
      .join('、');
  }

  invalidatedStageLabels(related: ChangeRequest): string {
    const item = this.change();
    if (!item) {
      return '';
    }
    const stages = invalidatedApprovals(related)
      .filter((approval) => approval.invalidatedByChangeId === item.id)
      .map((approval) => STAGE_LABELS[approval.stage]);
    return [...new Set(stages)].join('、');
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
      invalidated: '已失效',
    }[state];
  }

  approvalGate(): string {
    const item = this.change();
    if (!item) {
      return '-';
    }
    if (item.status === 'approved') {
      return '已批准，等待执行冻结';
    }
    if (isExecutionFrozen(item)) {
      return '审批已冻结（以执行版本为准）';
    }
    return '方案草稿';
  }

  decisionLabel(decision: DeviationDecision): string {
    return DECISION_LABELS[decision];
  }

  private clearApprovalForm(): void {
    this.approver.set('');
    this.approvalComment.set('');
  }
}

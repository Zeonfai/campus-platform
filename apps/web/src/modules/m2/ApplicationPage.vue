<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { components } from '@campus/contracts/api';
import { PublicApiError, useSession } from '../d/session';

type Application = components['schemas']['RoomApplication'];
type Policy = components['schemas']['ApprovalPolicy'];
type Room = components['schemas']['Room'];
type View = 'mine' | 'approvals';

const session = useSession();
const router = useRouter();
const permissions = computed(() => session.user?.permissions ?? []);
const canCreate = computed(() => permissions.value.includes('m2.applications.create'));
const canApprove = computed(() => permissions.value.includes('m2.approvals.decide'));
const canReadPolicies = computed(() => permissions.value.includes('m2.policies.read'));
const tomorrow = new Date(Date.now() + 86400000 + 8 * 3600000).toISOString().slice(0, 10);
const roomId = ref('');
const purpose = ref('');
const startsAt = ref(`${tomorrow}T09:00`);
const endsAt = ref(`${tomorrow}T11:00`);
const policyId = ref('');
const rooms = ref<Room[]>([]);
const roomCursor = ref<string | null>(null);
const roomBusy = ref(false);
const policies = ref<Policy[]>([]);
const policyCursor = ref<string | null>(null);
const policyBusy = ref(false);
const view = ref<View>('mine');
const statusFilter = ref('');
const applications = ref<Application[]>([]);
const cursor = ref<string | null>(null);
const listBusy = ref(false);
const detailBusy = ref(false);
const saving = ref(false);
const selectedId = ref<string>();
const selected = ref<Application>();
const comment = ref('');
const withdrawalReason = ref('');
const error = ref('');
const notice = ref('');
const keys = new Map<string, string>();
let generation = 0;
let listRequest = 0;
let detailRequest = 0;

const states: Record<Application['status'], string> = {
  PENDING: '等待审批',
  SYNCING: '正在确认教室占用',
  APPROVED: '已批准',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
  EXPIRED: '已超时撤销',
  RELEASE_PENDING: '正在确认撤销',
  SYNC_FAILED: '资源确认未成功',
};
const stepStates: Record<string, string> = {
  PENDING: '尚未审批',
  APPROVED: '已同意',
  REJECTED: '已驳回',
};
const scopes: Record<string, string> = {
  DEPARTMENT: '所属院系',
  MANAGED_ROOMS: '所管理的教室',
  ALL: '全部范围',
};
const currentStep = computed(() =>
  selected.value?.status === 'PENDING'
    ? selected.value.steps.find((step) => step.status === 'PENDING')
    : undefined,
);
const showDecision = computed(
  () =>
    view.value === 'approvals' &&
    canApprove.value &&
    Boolean(currentStep.value) &&
    selected.value?.applicantId !== session.user?.id &&
    !selected.value?.steps.some((step) => step.decidedBy === session.user?.id),
);
const canWithdraw = computed(
  () =>
    selected.value?.applicantId === session.user?.id &&
    ['PENDING', 'SYNCING', 'APPROVED', 'SYNC_FAILED'].includes(selected.value?.status ?? '') &&
    Date.parse(selected.value?.startsAt ?? '') > Date.now(),
);

function showError(failure: unknown, write = false): void {
  if (failure instanceof PublicApiError) {
    error.value =
      failure.status === 409
        ? '记录已变化或资源发生冲突，请刷新后查看最新状态'
        : failure.status === 422
          ? '当前状态无法执行此操作，请刷新详情'
          : write && failure.status >= 500
            ? '操作结果尚未确认，请刷新申请记录；重试时保持原来的内容'
            : failure.message;
  } else {
    error.value = write
      ? '操作结果尚未确认，请刷新申请记录；重试时保持原来的内容'
      : '暂时无法连接服务，请重试';
  }
}
function format(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
function roomName(id: string): string {
  const room = rooms.value.find((item) => item.id === id);
  return room ? `${room.code} · ${room.name}` : '申请教室';
}
function mergeItems(previous: Application[], incoming: Application[]): Application[] {
  const result = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = result.get(item.id);
    if (!existing || existing.revision <= item.revision) result.set(item.id, item);
  }
  return [...result.values()];
}
async function loadRooms(more = false): Promise<void> {
  if (roomBusy.value) return;
  const version = generation;
  roomBusy.value = true;
  try {
    const query = new URLSearchParams({ limit: '100' });
    if (more && roomCursor.value) query.set('cursor', roomCursor.value);
    const result = await session.request<components['schemas']['RoomPage']>(
      `/api/v1/rooms?${query}`,
    );
    if (version !== generation) return;
    rooms.value = more ? [...rooms.value, ...result.items] : result.items;
    roomCursor.value = result.nextCursor;
  } catch (failure) {
    if (version === generation) showError(failure);
  } finally {
    roomBusy.value = false;
  }
}
async function loadPolicies(more = false): Promise<void> {
  if (policyBusy.value || !canReadPolicies.value) return;
  const version = generation;
  policyBusy.value = true;
  try {
    const query = new URLSearchParams({ limit: '100' });
    if (more && policyCursor.value) query.set('cursor', policyCursor.value);
    const result = await session.request<components['schemas']['ApprovalPolicyPage']>(
      `/api/v1/approval-policies?${query}`,
    );
    if (version !== generation) return;
    policies.value = more ? [...policies.value, ...result.items] : result.items;
    policyCursor.value = result.nextCursor;
  } catch (failure) {
    if (version === generation) showError(failure);
  } finally {
    policyBusy.value = false;
  }
}
async function loadApplications(more = false): Promise<void> {
  const version = generation;
  const request = ++listRequest;
  listBusy.value = true;
  try {
    const query = new URLSearchParams({ view: view.value });
    if (statusFilter.value) query.set('status', statusFilter.value);
    if (more && cursor.value) query.set('cursor', cursor.value);
    const result = await session.request<components['schemas']['RoomApplicationPage']>(
      `/api/v1/applications?${query}`,
    );
    if (version !== generation || request !== listRequest) return;
    applications.value = more ? mergeItems(applications.value, result.items) : result.items;
    cursor.value = result.nextCursor;
  } catch (failure) {
    if (version === generation && request === listRequest) showError(failure);
  } finally {
    if (request === listRequest) listBusy.value = false;
  }
}
async function loadDetail(id: string): Promise<void> {
  const version = generation;
  const request = ++detailRequest;
  detailBusy.value = true;
  try {
    const result = await session.request<Application>(
      `/api/v1/applications/${encodeURIComponent(id)}`,
    );
    if (version !== generation || request !== detailRequest || selectedId.value !== id) return;
    if (
      !selected.value ||
      selected.value.id !== result.id ||
      selected.value.revision <= result.revision
    ) {
      selected.value = result;
    }
    const existing = applications.value.find((item) => item.id === id);
    if (existing && existing.revision <= result.revision) {
      applications.value = applications.value.map((item) => (item.id === id ? result : item));
    }
  } catch (failure) {
    if (version === generation && request === detailRequest) {
      if (failure instanceof PublicApiError && [403, 404].includes(failure.status)) {
        selected.value = undefined;
      }
      showError(failure);
    }
  } finally {
    if (request === detailRequest) detailBusy.value = false;
  }
}
function openDetail(item: Application): void {
  selectedId.value = item.id;
  if (
    !selected.value ||
    selected.value.id !== item.id ||
    selected.value.revision <= item.revision
  ) {
    selected.value = item;
  }
  comment.value = '';
  withdrawalReason.value = '';
  error.value = '';
  void loadDetail(item.id);
}
async function write(path: string, body: unknown): Promise<Application> {
  const intent = JSON.stringify([path, body]);
  let key = keys.get(intent);
  if (!key) {
    key = crypto.randomUUID();
    keys.set(intent, key);
  }
  const result = await session.request<Application>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  keys.delete(intent);
  return result;
}
async function submitApplication(): Promise<void> {
  if (saving.value || !canCreate.value) return;
  const version = generation;
  error.value = '';
  notice.value = '';
  const start = `${startsAt.value}:00+08:00`;
  const end = `${endsAt.value}:00+08:00`;
  if (Date.parse(start) <= Date.now() || Date.parse(end) <= Date.parse(start)) {
    error.value = '请选择未来的有效使用时段';
    return;
  }
  if (!purpose.value.trim()) {
    error.value = '请填写教室用途';
    return;
  }
  saving.value = true;
  try {
    const result = await write('/api/v1/applications', {
      roomId: roomId.value,
      purpose: purpose.value.trim(),
      startsAt: start,
      endsAt: end,
      ...(policyId.value ? { policyId: policyId.value } : {}),
    } satisfies components['schemas']['RoomApplicationInput']);
    if (version !== generation) return;
    purpose.value = '';
    selectedId.value = result.id;
    selected.value = undefined;
    notice.value = '申请已提交，尚未批准；请在详情中查看审批和教室确认进度';
    await Promise.all([loadApplications(), loadDetail(result.id)]);
  } catch (failure) {
    if (version === generation) showError(failure, true);
  } finally {
    saving.value = false;
  }
}
async function decide(decision: 'APPROVE' | 'REJECT'): Promise<void> {
  const item = selected.value;
  const step = currentStep.value;
  if (saving.value || !item || !step || !showDecision.value) return;
  const version = generation;
  error.value = '';
  notice.value = '';
  if (!comment.value.trim()) {
    error.value = '请填写审批意见';
    return;
  }
  saving.value = true;
  try {
    await write(
      `/api/v1/applications/${encodeURIComponent(item.id)}/steps/${encodeURIComponent(step.id)}/decision`,
      {
        decision,
        comment: comment.value.trim(),
        expectedRevision: item.revision,
      } satisfies components['schemas']['ApprovalInput'],
    );
    if (version !== generation) return;
    notice.value = '审批意见已保存，请查看最新申请状态';
    comment.value = '';
    await Promise.all([loadApplications(), loadDetail(item.id)]);
  } catch (failure) {
    if (version === generation) showError(failure, true);
  } finally {
    saving.value = false;
  }
}
async function withdraw(): Promise<void> {
  const item = selected.value;
  if (saving.value || !item || !canWithdraw.value) return;
  const version = generation;
  error.value = '';
  notice.value = '';
  if (!withdrawalReason.value.trim()) {
    error.value = '请填写撤回原因';
    return;
  }
  saving.value = true;
  try {
    await write(`/api/v1/applications/${encodeURIComponent(item.id)}/withdraw`, {
      reason: withdrawalReason.value.trim(),
      expectedRevision: item.revision,
    } satisfies components['schemas']['ApplicationWithdrawalInput']);
    if (version !== generation) return;
    notice.value = '撤回请求已保存；显示“已撤回”后才表示教室释放已确认';
    withdrawalReason.value = '';
    await Promise.all([loadApplications(), loadDetail(item.id)]);
  } catch (failure) {
    if (version === generation) showError(failure, true);
  } finally {
    saving.value = false;
  }
}
async function refresh(): Promise<void> {
  error.value = '';
  await Promise.all([
    loadApplications(),
    ...(selectedId.value ? [loadDetail(selectedId.value)] : []),
  ]);
}
watch([view, statusFilter], () => {
  applications.value = [];
  cursor.value = null;
  selectedId.value = undefined;
  selected.value = undefined;
  comment.value = '';
  withdrawalReason.value = '';
  notice.value = '';
  detailRequest++;
  detailBusy.value = false;
  if (session.loggedIn) void loadApplications();
});
watch(
  () => session.loggedIn,
  (loggedIn) => {
    if (loggedIn) return;
    generation++;
    applications.value = [];
    rooms.value = [];
    policies.value = [];
    selected.value = undefined;
    selectedId.value = undefined;
    keys.clear();
    purpose.value = '';
    comment.value = '';
    withdrawalReason.value = '';
    void router.replace('/login');
  },
);
onMounted(() => {
  if (!session.loggedIn) {
    void router.replace('/login');
    return;
  }
  void Promise.all([loadRooms(), loadPolicies(), loadApplications()]);
});
onBeforeUnmount(() => {
  generation++;
  keys.clear();
});
</script>

<template>
  <header class="page-header">
    <p class="eyebrow">ROOM APPLICATIONS</p>
    <h1>整教室申请</h1>
    <p>申请整间教室用于集体活动。使用时间按北京时间填写。</p>
  </header>
  <p class="notice">
    待审批申请不预占教室。按顺序完成审批并确认教室可用后，才会显示“已批准”；审批不得由申请人本人完成。
  </p>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <p v-if="notice" role="status">{{ notice }}</p>

  <section v-if="canCreate" class="panel application-panel">
    <h2>提交申请</h2>
    <form class="application-form" @submit.prevent="submitApplication">
      <label>
        教室
        <select v-model="roomId" required :disabled="saving || roomBusy">
          <option disabled value="">请选择教室</option>
          <option v-for="room in rooms" :key="room.id" :value="room.id" :disabled="!room.enabled">
            {{ room.code }} · {{ room.name }}{{ room.enabled ? '' : '（已停用）' }}
          </option>
        </select>
      </label>
      <label>
        审批流程
        <select v-model="policyId" :disabled="saving || policyBusy">
          <option value="">默认审批流程</option>
          <option v-for="policy in policies" :key="policy.id" :value="policy.id">
            {{ policy.name }} · {{ policy.steps.length }} 级审批
          </option>
        </select>
      </label>
      <label>
        开始时间
        <input v-model="startsAt" type="datetime-local" step="3600" required :disabled="saving" />
      </label>
      <label>
        结束时间
        <input v-model="endsAt" type="datetime-local" step="3600" required :disabled="saving" />
      </label>
      <label class="full-width">
        教室用途
        <textarea v-model="purpose" rows="3" maxlength="1000" required :disabled="saving" />
      </label>
      <div class="application-actions full-width">
        <button class="primary-button" type="submit" :disabled="saving || roomBusy || !roomId">
          {{ saving ? '正在提交…' : '提交申请' }}
        </button>
        <button
          v-if="roomCursor"
          type="button"
          class="secondary-button"
          :disabled="roomBusy || saving"
          @click="loadRooms(true)"
        >
          加载更多教室
        </button>
        <button
          type="button"
          class="secondary-button"
          :disabled="roomBusy || saving"
          @click="loadRooms()"
        >
          刷新教室
        </button>
      </div>
    </form>
    <p class="muted">教室目录只显示当前账号可见的空间；申请资格与审批范围会在提交时核对。</p>
  </section>
  <p v-else class="muted">
    当前账号没有提交整室申请的权限，可在下方查看本人记录或处理授权范围内的审批。
  </p>

  <section class="panel application-panel">
    <div class="panel-heading">
      <h2>{{ view === 'mine' ? '我的申请' : '我的审批' }}</h2>
      <button
        class="secondary-button"
        :disabled="listBusy || detailBusy || saving"
        @click="refresh"
      >
        {{ listBusy || detailBusy ? '刷新中…' : '刷新进度' }}
      </button>
    </div>
    <div class="application-filters">
      <label>
        查看范围
        <select v-model="view" :disabled="saving">
          <option value="mine">我的申请</option>
          <option v-if="canApprove" value="approvals">我的审批</option>
        </select>
      </label>
      <label>
        申请状态
        <select v-model="statusFilter" :disabled="saving">
          <option value="">全部状态</option>
          <option v-for="(label, status) in states" :key="status" :value="status">
            {{ label }}
          </option>
        </select>
      </label>
    </div>
    <p v-if="!listBusy && !applications.length" class="muted">当前范围内暂无申请记录。</p>
    <article v-for="item in applications" :key="item.id" class="booking-row">
      <div>
        <strong>{{ roomName(item.roomId) }} · {{ states[item.status] }}</strong>
        <p>{{ format(item.startsAt) }} — {{ format(item.endsAt) }}</p>
        <p class="application-purpose">{{ item.purpose }}</p>
      </div>
      <button class="secondary-button" :disabled="saving" @click="openDetail(item)">
        查看详情
      </button>
    </article>
    <button
      v-if="cursor"
      class="secondary-button"
      :disabled="listBusy || saving"
      @click="loadApplications(true)"
    >
      加载更多申请
    </button>
  </section>

  <section v-if="selectedId" class="panel application-panel" aria-label="申请详情">
    <div class="panel-heading">
      <h2>申请详情</h2>
      <button
        class="secondary-button"
        :disabled="detailBusy || saving"
        @click="loadDetail(selectedId)"
      >
        刷新详情
      </button>
    </div>
    <p v-if="detailBusy" class="muted">正在核对最新状态…</p>
    <template v-if="selected">
      <dl class="application-details">
        <dt>教室</dt>
        <dd>{{ roomName(selected.roomId) }}</dd>
        <dt>当前状态</dt>
        <dd>
          <strong>{{ states[selected.status] }}</strong>
        </dd>
        <dt>使用时间</dt>
        <dd>{{ format(selected.startsAt) }} — {{ format(selected.endsAt) }}</dd>
        <dt>审批截止</dt>
        <dd>{{ format(selected.deadlineAt) }}</dd>
        <dt>申请用途</dt>
        <dd class="application-purpose">{{ selected.purpose }}</dd>
      </dl>
      <p v-if="selected.status === 'SYNCING'" class="notice">
        审批意见已完成，正在确认教室占用。请稍后刷新，当前尚未批准。
      </p>
      <p v-if="selected.status === 'RELEASE_PENDING'" class="notice">
        撤销正在处理中，请刷新确认最终状态。
      </p>
      <p v-if="selected.status === 'SYNC_FAILED' || selected.syncError" class="form-error">
        教室资源尚未确认成功，请刷新最新状态或联系管理员。
      </p>
      <h3>审批记录</h3>
      <ol class="approval-steps">
        <li v-for="step in selected.steps" :key="step.id">
          <div>
            <strong>第 {{ step.position }} 级审批</strong> · {{ scopes[step.scope] ?? step.scope }}
          </div>
          <p>
            {{ stepStates[step.status] ?? step.status
            }}{{ step.decidedAt ? ` · ${format(step.decidedAt)}` : '' }}
          </p>
          <p v-if="step.comment" class="application-purpose">意见：{{ step.comment }}</p>
        </li>
      </ol>
      <form
        v-if="showDecision && currentStep"
        class="application-action-form"
        @submit.prevent="decide('APPROVE')"
      >
        <h3>处理第 {{ currentStep.position }} 级审批</h3>
        <label for="approval-comment">审批意见</label>
        <textarea
          id="approval-comment"
          v-model="comment"
          rows="3"
          maxlength="1000"
          required
          :disabled="saving || detailBusy"
        />
        <div class="application-actions">
          <button class="primary-button" type="submit" :disabled="saving || detailBusy">
            同意本级审批
          </button>
          <button
            class="secondary-button"
            type="button"
            :disabled="saving || detailBusy"
            @click="decide('REJECT')"
          >
            驳回申请
          </button>
        </div>
        <p class="muted">仅当前审批角色及管理范围内的人员可处理；不同审批级别须由不同人员完成。</p>
      </form>
      <form v-if="canWithdraw" class="application-action-form" @submit.prevent="withdraw">
        <h3>撤回申请</h3>
        <label for="withdrawal-reason">撤回原因</label>
        <textarea
          id="withdrawal-reason"
          v-model="withdrawalReason"
          rows="2"
          maxlength="1000"
          required
          :disabled="saving || detailBusy"
        />
        <button class="secondary-button" type="submit" :disabled="saving || detailBusy">
          提交撤回请求
        </button>
      </form>
    </template>
  </section>

  <section v-if="canReadPolicies" class="panel application-panel">
    <div class="panel-heading">
      <h2>审批流程说明</h2>
      <button class="secondary-button" :disabled="policyBusy" @click="loadPolicies()">
        刷新流程
      </button>
    </div>
    <p class="muted">审批按申请提交时的流程执行；截止时间取流程时限与使用开始时间中较早的一个。</p>
    <p v-if="!policyBusy && !policies.length" class="muted">暂无可查看的审批流程。</p>
    <article v-for="policy in policies" :key="policy.id" class="policy-row">
      <h3>{{ policy.name }}</h3>
      <p>审批时限 {{ policy.timeoutMinutes }} 分钟 · {{ policy.steps.length }} 级审批</p>
      <ol>
        <li v-for="(step, index) in policy.steps" :key="index">
          第 {{ index + 1 }} 级 · {{ scopes[step.scope] ?? step.scope }}
        </li>
      </ol>
    </article>
    <button
      v-if="policyCursor"
      class="secondary-button"
      :disabled="policyBusy"
      @click="loadPolicies(true)"
    >
      加载更多流程
    </button>
  </section>
</template>

<style scoped>
.application-panel {
  margin-top: 24px;
}
.application-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
.application-form label,
.application-filters label,
.application-action-form {
  display: grid;
  gap: 8px;
  font-size: 14px;
}
.application-form input,
.application-form select,
.application-form textarea,
.application-filters select,
.application-action-form textarea {
  width: 100%;
  min-height: 42px;
  padding: 10px 12px;
  border: 1px solid #b7c8d0;
  border-radius: 6px;
  font: inherit;
}
.application-form textarea,
.application-action-form textarea {
  resize: vertical;
}
.full-width {
  grid-column: 1 / -1;
}
.application-actions,
.application-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 12px;
}
.application-filters {
  margin: 20px 0;
}
.application-actions .primary-button {
  margin-top: 0;
}
.application-details {
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 12px;
  font-size: 14px;
}
.application-details dt {
  color: #64748b;
}
.application-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.application-purpose {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.approval-steps {
  padding-left: 24px;
}
.approval-steps li {
  padding: 10px 0;
}
.approval-steps p {
  margin: 6px 0;
}
.application-action-form,
.policy-row {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid #e1e8ed;
}
.application-action-form h3 {
  margin: 0 0 8px;
}
.application-action-form > button {
  justify-self: start;
}
@media (max-width: 600px) {
  .application-form {
    grid-template-columns: 1fr;
  }
  .booking-row {
    flex-wrap: wrap;
  }
  .application-details {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .application-details dd {
    margin-bottom: 10px;
  }
}
</style>

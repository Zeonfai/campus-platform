<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { components } from '@campus/contracts/api';
import { PublicApiError, useSession } from '../d/session';

type WorkOrder = components['schemas']['WorkOrder'];
type Policy = components['schemas']['MaintenancePolicy'];
type Room = components['schemas']['Room'];
type View = 'mine' | 'managed' | 'assigned';
type Action = 'assign' | 'start' | 'complete' | 'accept' | 'cancel' | 'rating';

const session = useSession();
const router = useRouter();
const permissions = computed(() => session.user?.permissions ?? []);
const has = (permission: string): boolean => permissions.value.includes(permission);
const canCreate = computed(() => has('m3.work-orders.create'));
const canManage = computed(() => ['m3.dispatch', 'm3.accept', 'm3.cancel'].some(has));
const canRepair = computed(() => has('m3.repair'));
const canReadPolicies = computed(() => has('m3.policies.read') || has('m3.policies.write'));
const roomId = ref('');
const category = ref('');
const description = ref('');
const policyId = ref('');
const rooms = ref<Room[]>([]);
const roomCursor = ref<string | null>(null);
const roomBusy = ref(false);
const policies = ref<Policy[]>([]);
const policyCursor = ref<string | null>(null);
const policyBusy = ref(false);
const view = ref<View>('mine');
const statusFilter = ref('');
const orders = ref<WorkOrder[]>([]);
const cursor = ref<string | null>(null);
const listBusy = ref(false);
const detailBusy = ref(false);
const saving = ref(false);
const selectedId = ref<string>();
const selected = ref<WorkOrder>();
const assigneeId = ref('');
const assignmentReason = ref('');
const startReason = ref('');
const completionNote = ref('');
const acceptanceComment = ref('');
const cancellationReason = ref('');
const ratingScore = ref(5);
const ratingComment = ref('');
const error = ref('');
const notice = ref('');
const keys = new Map<string, string>();
let generation = 0;
let listRequest = 0;
let detailRequest = 0;

const states: Record<WorkOrder['status'], string> = {
  NEW: '等待派单',
  ASSIGNED: '已派单',
  BLOCK_PENDING: '正在确认维修封锁',
  IN_REPAIR: '维修中',
  AWAITING_ACCEPTANCE: '待验收',
  RELEASE_PENDING: '验收通过，正在确认恢复',
  CLOSED: '已关闭',
  CANCELLED: '已取消',
  SYNC_FAILED: '维修封锁未确认',
};
const actions: Record<string, string> = {
  'work_order.created': '提交报修',
  'work_order.assigned': '指派维修人员',
  'work_order.start_requested': '申请开始维修',
  'work_order.completed': '提交完工说明',
  'work_order.accepted': '验收通过',
  'work_order.acceptance_rejected': '验收不通过，继续维修',
  'work_order.cancelled': '取消报修',
  'work_order.rated': '提交评价',
  'resource.command_confirmed': '资源变更已确认',
  'resource.command_failed': '资源变更未确认',
  'resource.recovery_scheduled': '已安排资源同步恢复',
  'sla.escalated': '超过处理时限，已升级',
};
const stages: Record<string, string> = {
  RESPONSE: '响应派单',
  REPAIR: '维修处理',
  ACCEPTANCE: '完工验收',
};
const escalationEvents = computed(
  () => selected.value?.events.filter((event) => event.action === 'sla.escalated') ?? [],
);
const showAssignment = computed(
  () => has('m3.dispatch') && ['NEW', 'ASSIGNED'].includes(selected.value?.status ?? ''),
);
const showStart = computed(
  () =>
    canRepair.value &&
    selected.value?.assigneeId === session.user?.id &&
    ['ASSIGNED', 'SYNC_FAILED'].includes(selected.value?.status ?? ''),
);
const showCompletion = computed(
  () =>
    canRepair.value &&
    selected.value?.assigneeId === session.user?.id &&
    selected.value?.status === 'IN_REPAIR',
);
const showAcceptance = computed(
  () =>
    has('m3.accept') &&
    selected.value?.assigneeId !== session.user?.id &&
    selected.value?.status === 'AWAITING_ACCEPTANCE',
);
const showCancellation = computed(
  () => has('m3.cancel') && ['NEW', 'ASSIGNED'].includes(selected.value?.status ?? ''),
);
const showRating = computed(
  () =>
    has('m3.rate') &&
    selected.value?.reporterId === session.user?.id &&
    selected.value?.status === 'CLOSED' &&
    selected.value.rating === null,
);

function showError(failure: unknown, write = false): void {
  if (failure instanceof PublicApiError) {
    error.value =
      failure.status === 409
        ? '工单已变化或提交内容发生冲突，请刷新详情后再操作'
        : failure.status === 422
          ? '当前阶段无法执行此操作，请刷新工单详情'
          : write && failure.status >= 500
            ? '操作结果尚未确认，请刷新工单；重试时保持原来的内容'
            : failure.message;
  } else {
    error.value = write
      ? '操作结果尚未确认，请刷新工单；重试时保持原来的内容'
      : '暂时无法连接服务，请重试';
  }
}
function format(value: string | null): string {
  if (!value) return '尚未开始计时';
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
  return room ? `${room.code} · ${room.name}` : id;
}
function eventDetail(event: WorkOrder['events'][number]): string {
  const data = event.data;
  const parts: string[] = [];
  if (typeof data.reason === 'string') parts.push(data.reason);
  if (typeof data.comment === 'string') parts.push(data.comment);
  if (typeof data.assigneeName === 'string') parts.push(`维修人员：${data.assigneeName}`);
  else if (typeof data.assigneeId === 'string') parts.push(`维修人员：${data.assigneeId}`);
  if (typeof data.score === 'number') parts.push(`评分：${data.score} / 5`);
  if (event.action === 'sla.escalated') {
    if (typeof data.stage === 'string') parts.push(stages[data.stage] ?? data.stage);
    if (typeof data.deadlineAt === 'string') parts.push(`处理期限：${format(data.deadlineAt)}`);
    if (Array.isArray(data.recipientIds)) {
      const recipients = data.recipientIds.filter((id): id is string => typeof id === 'string');
      parts.push(recipients.length ? `升级接收人：${recipients.join('、')}` : '暂无可用升级接收人');
    }
  }
  return parts.join(' · ');
}
function mergeItems(previous: WorkOrder[], incoming: WorkOrder[]): WorkOrder[] {
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
    if (version === generation) roomBusy.value = false;
  }
}
async function loadPolicies(more = false): Promise<void> {
  if (policyBusy.value || !canReadPolicies.value) return;
  const version = generation;
  policyBusy.value = true;
  try {
    const query = new URLSearchParams({ limit: '100' });
    if (more && policyCursor.value) query.set('cursor', policyCursor.value);
    const result = await session.request<components['schemas']['MaintenancePolicyPage']>(
      `/api/v1/maintenance-policies?${query}`,
    );
    if (version !== generation) return;
    policies.value = more ? [...policies.value, ...result.items] : result.items;
    policyCursor.value = result.nextCursor;
  } catch (failure) {
    if (version === generation) showError(failure);
  } finally {
    if (version === generation) policyBusy.value = false;
  }
}
async function loadOrders(more = false): Promise<void> {
  const version = generation;
  const request = ++listRequest;
  listBusy.value = true;
  try {
    const query = new URLSearchParams({ view: view.value });
    if (statusFilter.value) query.set('status', statusFilter.value);
    if (more && cursor.value) query.set('cursor', cursor.value);
    const result = await session.request<components['schemas']['WorkOrderPage']>(
      `/api/v1/work-orders?${query}`,
    );
    if (version !== generation || request !== listRequest) return;
    orders.value = more ? mergeItems(orders.value, result.items) : result.items;
    cursor.value = result.nextCursor;
  } catch (failure) {
    if (version === generation && request === listRequest) showError(failure);
  } finally {
    if (version === generation && request === listRequest) listBusy.value = false;
  }
}
async function loadDetail(id: string): Promise<void> {
  const version = generation;
  const request = ++detailRequest;
  detailBusy.value = true;
  try {
    const result = await session.request<WorkOrder>(
      `/api/v1/work-orders/${encodeURIComponent(id)}`,
    );
    if (version !== generation || request !== detailRequest || selectedId.value !== id) return;
    if (!selected.value || selected.value.id !== id || selected.value.revision <= result.revision) {
      selected.value = result;
    }
    const previous = orders.value.find((item) => item.id === id);
    if (previous && previous.revision <= result.revision) {
      orders.value = orders.value.map((item) => (item.id === id ? result : item));
    }
  } catch (failure) {
    if (version === generation && request === detailRequest) {
      if (failure instanceof PublicApiError && [403, 404].includes(failure.status)) {
        selected.value = undefined;
      }
      showError(failure);
    }
  } finally {
    if (version === generation && request === detailRequest) detailBusy.value = false;
  }
}
function clearActionInputs(): void {
  assigneeId.value = '';
  assignmentReason.value = '';
  startReason.value = '';
  completionNote.value = '';
  acceptanceComment.value = '';
  cancellationReason.value = '';
  ratingScore.value = 5;
  ratingComment.value = '';
}
function openDetail(item: WorkOrder): void {
  selectedId.value = item.id;
  if (
    !selected.value ||
    selected.value.id !== item.id ||
    selected.value.revision <= item.revision
  ) {
    selected.value = item;
  }
  clearActionInputs();
  error.value = '';
  void loadDetail(item.id);
}
async function write(path: string, body: unknown): Promise<WorkOrder> {
  const intent = JSON.stringify([path, body]);
  let key = keys.get(intent);
  if (!key) {
    key = crypto.randomUUID();
    keys.set(intent, key);
  }
  const result = await session.request<WorkOrder>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  keys.delete(intent);
  return result;
}
async function submitReport(): Promise<void> {
  if (saving.value || !canCreate.value) return;
  if (!roomId.value || !category.value.trim() || !description.value.trim()) {
    error.value = '请选择教室并填写故障类别及描述';
    return;
  }
  const version = generation;
  error.value = '';
  notice.value = '';
  saving.value = true;
  try {
    const result = await write('/api/v1/work-orders', {
      roomId: roomId.value,
      category: category.value.trim(),
      description: description.value.trim(),
      ...(policyId.value ? { policyId: policyId.value } : {}),
    } satisfies components['schemas']['WorkOrderInput']);
    if (version !== generation) return;
    category.value = '';
    description.value = '';
    selectedId.value = result.id;
    selected.value = undefined;
    clearActionInputs();
    notice.value = '报修已提交，请查看派单与处理进度';
    await Promise.all([loadOrders(), loadDetail(result.id)]);
  } catch (failure) {
    if (version === generation) showError(failure, true);
  } finally {
    if (version === generation) saving.value = false;
  }
}
async function perform(action: Action, accepted?: boolean): Promise<void> {
  const item = selected.value;
  if (saving.value || detailBusy.value || !item) return;
  const actionEnabled: Record<Action, boolean> = {
    assign: showAssignment.value,
    start: showStart.value,
    complete: showCompletion.value,
    accept: showAcceptance.value,
    cancel: showCancellation.value,
    rating: showRating.value,
  };
  if (!actionEnabled[action]) return;
  let body:
    | components['schemas']['AssignInput']
    | components['schemas']['WorkOrderActionInput']
    | components['schemas']['AcceptanceInput']
    | components['schemas']['RatingInput'];
  switch (action) {
    case 'assign':
      if (!assigneeId.value.trim() || !assignmentReason.value.trim()) {
        error.value = '请填写维修人员账号 ID 和派单原因';
        return;
      }
      body = {
        assigneeId: assigneeId.value.trim(),
        reason: assignmentReason.value.trim(),
        expectedRevision: item.revision,
      };
      break;
    case 'accept':
      if (!acceptanceComment.value.trim() || accepted === undefined) {
        error.value = '请填写验收意见';
        return;
      }
      body = { accepted, comment: acceptanceComment.value.trim(), expectedRevision: item.revision };
      break;
    case 'rating':
      if (!ratingComment.value.trim()) {
        error.value = '请填写评价意见';
        return;
      }
      body = {
        score: Number(ratingScore.value),
        comment: ratingComment.value.trim(),
        expectedRevision: item.revision,
      };
      break;
    default: {
      const reason = (
        action === 'start'
          ? startReason.value
          : action === 'complete'
            ? completionNote.value
            : cancellationReason.value
      ).trim();
      if (!reason) {
        error.value = action === 'complete' ? '请填写维修结果及完工说明' : '请填写操作原因';
        return;
      }
      body = { reason, expectedRevision: item.revision };
    }
  }
  const version = generation;
  error.value = '';
  notice.value = '';
  saving.value = true;
  try {
    await write(`/api/v1/work-orders/${encodeURIComponent(item.id)}/${action}`, body);
    if (version !== generation) return;
    const messages: Record<Action, string> = {
      assign: '派单已保存，请查看当前负责人与最新进度',
      start: '开始维修请求已保存；确认封锁后才会显示“维修中”',
      complete: '完工说明已保存，验收完成前教室仍保持维修封锁',
      accept: accepted
        ? '验收意见已保存；显示“已关闭”后才表示本工单封锁释放已确认'
        : '验收未通过，工单继续维修，教室仍保持封锁',
      cancel: '取消请求已保存，请查看最新状态',
      rating: '评价已保存',
    };
    notice.value = messages[action];
    clearActionInputs();
    // Write receipts can be historical. Only GET updates the visible current state.
    await Promise.all([loadOrders(), loadDetail(item.id)]);
  } catch (failure) {
    if (version === generation) showError(failure, true);
  } finally {
    if (version === generation) saving.value = false;
  }
}
async function refresh(): Promise<void> {
  error.value = '';
  await Promise.all([loadOrders(), ...(selectedId.value ? [loadDetail(selectedId.value)] : [])]);
}
watch([view, statusFilter], () => {
  orders.value = [];
  cursor.value = null;
  selectedId.value = undefined;
  selected.value = undefined;
  clearActionInputs();
  notice.value = '';
  detailRequest++;
  detailBusy.value = false;
  if (session.loggedIn) void loadOrders();
});
watch(
  () => session.loggedIn,
  (loggedIn) => {
    if (loggedIn) return;
    generation++;
    listRequest++;
    detailRequest++;
    orders.value = [];
    rooms.value = [];
    policies.value = [];
    selected.value = undefined;
    selectedId.value = undefined;
    keys.clear();
    category.value = '';
    description.value = '';
    clearActionInputs();
    void router.replace('/login');
  },
);
onMounted(() => {
  if (!session.loggedIn) {
    void router.replace('/login');
    return;
  }
  void Promise.all([loadRooms(), loadPolicies(), loadOrders()]);
});
onBeforeUnmount(() => {
  generation++;
  keys.clear();
});
</script>

<template>
  <header class="page-header">
    <p class="eyebrow">MAINTENANCE WORK ORDERS</p>
    <h1>物业报修</h1>
    <p>提交故障，跟踪派单、维修与验收。所有时间按北京时间显示。</p>
  </header>
  <p class="notice">
    维修封锁确认后才能开始维修；完工须通过验收并确认恢复后才关闭工单。超时会升级处理，已确认的维修封锁不会自动解除。
  </p>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <p v-if="notice" role="status">{{ notice }}</p>

  <section v-if="canCreate" class="panel work-order-panel">
    <h2>提交报修</h2>
    <form class="work-order-form" @submit.prevent="submitReport">
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
        故障类别
        <input
          v-model="category"
          maxlength="200"
          required
          placeholder="如照明、插座、桌椅"
          :disabled="saving"
        />
      </label>
      <label v-if="canReadPolicies">
        处理时限
        <select v-model="policyId" :disabled="saving || policyBusy">
          <option value="">默认处理政策</option>
          <option v-for="policy in policies" :key="policy.id" :value="policy.id">
            {{ policy.name }}
          </option>
        </select>
      </label>
      <label class="full-width">
        故障描述
        <textarea
          v-model="description"
          rows="3"
          maxlength="1000"
          required
          :disabled="saving"
          placeholder="说明故障位置、表现和影响；请勿填写与维修无关的个人敏感信息"
        />
      </label>
      <div class="work-order-actions full-width">
        <button class="primary-button" type="submit" :disabled="saving || roomBusy || !roomId">
          {{ saving ? '正在提交…' : '提交报修' }}
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
    <p class="muted">可报修范围及维修资格由服务核对；紧急人身安全问题请同时联系学校值班人员。</p>
  </section>
  <p v-else class="muted">当前账号没有提交报修的权限，可查看本人记录及授权范围内的工单。</p>

  <section class="panel work-order-panel">
    <div class="panel-heading">
      <h2>
        {{
          view === 'mine' ? '我的报修' : view === 'managed' ? '管理范围内工单' : '指派给我的工单'
        }}
      </h2>
      <button
        class="secondary-button"
        :disabled="listBusy || detailBusy || saving"
        @click="refresh"
      >
        {{ listBusy || detailBusy ? '刷新中…' : '刷新进度' }}
      </button>
    </div>
    <div class="work-order-filters">
      <label>
        查看范围
        <select v-model="view" :disabled="saving">
          <option value="mine">我的报修</option>
          <option v-if="canManage" value="managed">管理范围内工单</option>
          <option v-if="canRepair" value="assigned">指派给我的工单</option>
        </select>
      </label>
      <label>
        工单状态
        <select v-model="statusFilter" :disabled="saving">
          <option value="">全部状态</option>
          <option v-for="(label, status) in states" :key="status" :value="status">
            {{ label }}
          </option>
        </select>
      </label>
    </div>
    <p v-if="!listBusy && !orders.length" class="muted">当前范围内暂无工单。</p>
    <article v-for="item in orders" :key="item.id" class="booking-row">
      <div>
        <strong>{{ roomName(item.roomId) }} · {{ states[item.status] }}</strong>
        <p>{{ item.category }} · {{ format(item.createdAt) }}</p>
        <p class="work-order-text">{{ item.description }}</p>
        <p v-if="item.assigneeId" class="muted">
          维修人员：{{ item.assigneeName ?? item.assigneeId }}
        </p>
        <p v-if="item.syncError" class="form-error">资源同步尚待确认，请打开详情查看。</p>
      </div>
      <button class="secondary-button" :disabled="saving" @click="openDetail(item)">
        查看详情
      </button>
    </article>
    <button
      v-if="cursor"
      class="secondary-button"
      :disabled="listBusy || saving"
      @click="loadOrders(true)"
    >
      加载更多工单
    </button>
  </section>

  <section v-if="selectedId" class="panel work-order-panel" aria-label="工单详情">
    <div class="panel-heading">
      <h2>工单详情</h2>
      <button
        class="secondary-button"
        :disabled="detailBusy || saving"
        @click="loadDetail(selectedId)"
      >
        刷新详情
      </button>
    </div>
    <p v-if="detailBusy" class="muted">正在获取最新工单…</p>
    <template v-if="selected">
      <dl class="work-order-details">
        <dt>状态</dt>
        <dd>{{ states[selected.status] }}</dd>
        <dt>工单编号</dt>
        <dd>{{ selected.id }}</dd>
        <dt>教室</dt>
        <dd>{{ roomName(selected.roomId) }}</dd>
        <dt>故障类别</dt>
        <dd>{{ selected.category }}</dd>
        <dt>故障描述</dt>
        <dd class="work-order-text">{{ selected.description }}</dd>
        <dt>报修人</dt>
        <dd>{{ selected.reporterId }}</dd>
        <dt>维修人员</dt>
        <dd>{{ selected.assigneeName ?? selected.assigneeId ?? '尚未指派' }}</dd>
        <dt>响应期限</dt>
        <dd>{{ format(selected.responseDeadlineAt) }}</dd>
        <dt>维修期限</dt>
        <dd>{{ format(selected.repairDeadlineAt) }}</dd>
        <dt>验收期限</dt>
        <dd>{{ format(selected.acceptanceDeadlineAt) }}</dd>
        <dt>提交时间</dt>
        <dd>{{ format(selected.createdAt) }}</dd>
        <dt>最近更新</dt>
        <dd>{{ format(selected.updatedAt) }}</dd>
      </dl>
      <p v-if="selected.syncError" class="notice" role="status">
        资源同步仍需处理（{{
          selected.syncError
        }}）。请刷新进度；尚未确认封锁时不得开始维修，尚未确认释放时不会关闭工单。
      </p>
      <p
        v-if="['IN_REPAIR', 'AWAITING_ACCEPTANCE', 'RELEASE_PENDING'].includes(selected.status)"
        class="muted"
      >
        本工单恢复只解除本次维修封锁；同一教室仍可能有其他维修、预约或整室占用。
      </p>
      <section v-if="escalationEvents.length" class="escalation-summary" aria-label="超时升级">
        <h3>超时升级记录</h3>
        <p v-for="event in escalationEvents" :key="event.id">
          {{ format(event.createdAt) }} · {{ eventDetail(event) }}
        </p>
        <p class="muted">超时升级不会自动解除维修封锁。</p>
      </section>

      <form
        v-if="showAssignment"
        class="work-order-action-form"
        @submit.prevent="perform('assign')"
      >
        <h3>{{ selected.assigneeId ? '重新指派维修人员' : '指派维修人员' }}</h3>
        <label for="repair-assignee">维修人员账号 ID</label>
        <input
          id="repair-assignee"
          v-model="assigneeId"
          maxlength="100"
          required
          :disabled="saving || detailBusy"
          autocomplete="off"
        />
        <label for="assignment-reason">派单原因</label>
        <textarea
          id="assignment-reason"
          v-model="assignmentReason"
          rows="2"
          maxlength="1000"
          required
          :disabled="saving || detailBusy"
        />
        <button class="primary-button" :disabled="saving || detailBusy">保存派单</button>
        <p class="muted">
          服务会核对维修人员是否启用、具备维修权限且能处理该教室；维修开始后不能直接转派。
        </p>
      </form>
      <form v-if="showStart" class="work-order-action-form" @submit.prevent="perform('start')">
        <h3>开始维修</h3>
        <label for="repair-start">维修说明</label>
        <textarea
          id="repair-start"
          v-model="startReason"
          rows="2"
          maxlength="1000"
          required
          :disabled="saving || detailBusy"
        />
        <button class="primary-button" :disabled="saving || detailBusy">请求封锁并开始维修</button>
        <p class="muted">提交后先确认整室封锁；请等待状态变为“维修中”。</p>
      </form>
      <form
        v-if="showCompletion"
        class="work-order-action-form"
        @submit.prevent="perform('complete')"
      >
        <h3>提交完工</h3>
        <label for="repair-completion">维修结果及完工说明</label>
        <textarea
          id="repair-completion"
          v-model="completionNote"
          rows="3"
          maxlength="1000"
          required
          :disabled="saving || detailBusy"
        />
        <button class="primary-button" :disabled="saving || detailBusy">提交完工，等待验收</button>
        <p class="muted">提交完工后教室仍封锁，须由具有相应权限的另一人验收。</p>
      </form>
      <form
        v-if="showAcceptance"
        class="work-order-action-form"
        @submit.prevent="perform('accept', true)"
      >
        <h3>验收维修结果</h3>
        <label for="repair-acceptance">验收意见</label>
        <textarea
          id="repair-acceptance"
          v-model="acceptanceComment"
          rows="3"
          maxlength="1000"
          required
          :disabled="saving || detailBusy"
        />
        <div class="work-order-actions">
          <button class="primary-button" :disabled="saving || detailBusy">
            验收通过并申请恢复
          </button>
          <button
            type="button"
            class="secondary-button"
            :disabled="saving || detailBusy"
            @click="perform('accept', false)"
          >
            验收不通过，继续维修
          </button>
        </div>
        <p class="muted">仅能验收管理范围内的工单，维修人员不能验收自己的维修结果。</p>
      </form>
      <form
        v-if="showCancellation"
        class="work-order-action-form"
        @submit.prevent="perform('cancel')"
      >
        <h3>取消报修</h3>
        <label for="repair-cancellation">取消原因</label>
        <textarea
          id="repair-cancellation"
          v-model="cancellationReason"
          rows="2"
          maxlength="1000"
          required
          :disabled="saving || detailBusy"
        />
        <button class="secondary-button" :disabled="saving || detailBusy">取消本工单</button>
        <p class="muted">
          仅报修人或管理范围内授权人员可在维修封锁前取消，维修开始后须按完工验收流程处理。
        </p>
      </form>
      <form v-if="showRating" class="work-order-action-form" @submit.prevent="perform('rating')">
        <h3>评价本次维修</h3>
        <label for="repair-score">评分</label>
        <select id="repair-score" v-model.number="ratingScore" :disabled="saving || detailBusy">
          <option v-for="score in 5" :key="score" :value="score">{{ score }} 分</option>
        </select>
        <label for="repair-rating-comment">评价意见</label>
        <textarea
          id="repair-rating-comment"
          v-model="ratingComment"
          rows="3"
          maxlength="1000"
          required
          :disabled="saving || detailBusy"
        />
        <button class="primary-button" :disabled="saving || detailBusy">提交评价</button>
        <p class="muted">工单关闭后由报修人评价一次，提交后不能修改。</p>
      </form>
      <p v-if="selected.rating !== null" class="notice">
        本次评价：{{ selected.rating }} / 5 · {{ selected.ratingComment }}
      </p>

      <section class="history" aria-label="工单历史">
        <h3>处理历史</h3>
        <p class="muted">显示最近 100 条处理记录。</p>
        <ol>
          <li v-for="event in selected.events" :key="event.id">
            <strong>{{ actions[event.action] ?? '工单状态更新' }}</strong>
            <p>{{ format(event.createdAt) }} · {{ event.actorId }}</p>
            <p v-if="eventDetail(event)" class="work-order-text">{{ eventDetail(event) }}</p>
          </li>
        </ol>
      </section>
    </template>
  </section>

  <section v-if="canReadPolicies" class="panel work-order-panel">
    <div class="panel-heading">
      <h2>处理时限说明</h2>
      <button class="secondary-button" :disabled="policyBusy" @click="loadPolicies()">
        刷新政策
      </button>
    </div>
    <p class="muted">工单按提交时保存的政策执行；超时记录会保留在处理历史中。</p>
    <p v-if="!policyBusy && !policies.length" class="muted">暂无可查看的处理政策。</p>
    <article v-for="policy in policies" :key="policy.id" class="policy-row">
      <h3>{{ policy.name }}</h3>
      <p>
        响应派单 {{ policy.responseMinutes }} 分钟 · 维修处理 {{ policy.repairMinutes }} 分钟 ·
        完工验收 {{ policy.acceptanceMinutes }} 分钟
      </p>
    </article>
    <button
      v-if="policyCursor"
      class="secondary-button"
      :disabled="policyBusy"
      @click="loadPolicies(true)"
    >
      加载更多政策
    </button>
  </section>
</template>

<style scoped>
.work-order-panel {
  margin-top: 24px;
}
.work-order-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
.work-order-form label,
.work-order-filters label,
.work-order-action-form {
  display: grid;
  gap: 8px;
  font-size: 14px;
}
.work-order-form input,
.work-order-form select,
.work-order-form textarea,
.work-order-filters select,
.work-order-action-form input,
.work-order-action-form select,
.work-order-action-form textarea {
  width: 100%;
  min-height: 42px;
  padding: 10px 12px;
  border: 1px solid #b7c8d0;
  border-radius: 6px;
  font: inherit;
}
.work-order-form textarea,
.work-order-action-form textarea {
  resize: vertical;
}
.full-width {
  grid-column: 1 / -1;
}
.work-order-actions,
.work-order-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 12px;
}
.work-order-filters {
  margin: 20px 0;
}
.work-order-actions .primary-button {
  margin-top: 0;
}
.work-order-details {
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 12px;
  font-size: 14px;
}
.work-order-details dt {
  color: #64748b;
}
.work-order-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.work-order-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.work-order-action-form,
.policy-row,
.history,
.escalation-summary {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid #e1e8ed;
}
.work-order-action-form h3 {
  margin: 0 0 8px;
}
.work-order-action-form > button {
  justify-self: start;
}
.history ol {
  padding-left: 24px;
}
.history li {
  padding: 10px 0;
}
.history p {
  margin: 6px 0;
}
@media (max-width: 600px) {
  .work-order-form {
    grid-template-columns: 1fr;
  }
  .booking-row {
    flex-wrap: wrap;
  }
  .work-order-details {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .work-order-details dd {
    margin-bottom: 10px;
  }
}
</style>

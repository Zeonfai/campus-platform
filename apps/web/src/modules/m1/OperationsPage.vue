<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { components } from '@campus/contracts/api';
import { useSession, PublicApiError } from '../d/session';

const session = useSession();
const router = useRouter();
const shanghaiDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const start = ref(shanghaiDay() + 'T00:00');
const end = ref(shanghaiDay() + 'T23:00');
const roomId = ref('');
const rooms = ref<components['schemas']['Room'][]>([]);
const roomCursor = ref<string | null>(null);
const code = ref<components['schemas']['CheckInCode']>();
const reasons = ref<components['schemas']['ResourceReason'][]>([]);
const stats = ref<components['schemas']['BookingStatistics'][]>([]);
const reasonCursor = ref<string | null>(null);
const statCursor = ref<string | null>(null);
const policy = ref<components['schemas']['BookingPolicy']>();
const error = ref('');
const notice = ref('');
const busy = ref(false);
const keys = new Map<string, string>();
let generation = 0;
let dayTimer: ReturnType<typeof setInterval> | undefined;
const can = (permission: string) => session.user?.permissions.includes(permission) ?? false;
const management = computed(() =>
  ['m1.statistics.read', 'm1.resource-reasons.read', 'm1.checkin-code.display'].some(can),
);
function query(cursor?: string | null) {
  const params = new URLSearchParams({
    startsAt: start.value + ':00+08:00',
    endsAt: end.value + ':00+08:00',
  });
  if (cursor) params.set('cursor', cursor);
  return params;
}
function format(value?: string | null) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '无固定终点';
}
async function run(action: (version: number) => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  const version = generation;
  try {
    await action(version);
  } catch (failure) {
    if (version !== generation) return;
    error.value =
      failure instanceof PublicApiError
        ? failure.status === 409
          ? '规则版本已变更或请求内容冲突，请重新读取后再保存'
          : failure.message
        : '请求结果未确认，请刷新或用原按钮重试';
  } finally {
    busy.value = false;
  }
}
async function loadRooms(more = false) {
  await run(async (version) => {
    const result = await session.request<components['schemas']['RoomPage']>(
      '/api/v1/rooms' +
        (more && roomCursor.value ? '?cursor=' + encodeURIComponent(roomCursor.value) : ''),
    );
    if (version !== generation) return;
    rooms.value = more ? [...rooms.value, ...result.items] : result.items;
    roomCursor.value = result.nextCursor;
    if (!roomId.value) roomId.value = rooms.value[0]?.id ?? '';
  });
}
async function showCode() {
  code.value = undefined;
  await run(async (version) => {
    const result = await session.request<components['schemas']['CheckInCode']>(
      '/api/v1/rooms/' + encodeURIComponent(roomId.value) + '/check-in-code',
    );
    if (version === generation) code.value = result;
  });
}
async function loadReasons(more = false) {
  if (!more) {
    reasons.value = [];
    reasonCursor.value = null;
  }
  await run(async (version) => {
    const result = await session.request<components['schemas']['ResourceReasonPage']>(
      '/api/v1/rooms/' +
        encodeURIComponent(roomId.value) +
        '/resource-reasons?' +
        query(more ? reasonCursor.value : null),
    );
    if (version !== generation) return;
    reasons.value = more ? [...reasons.value, ...result.items] : result.items;
    reasonCursor.value = result.nextCursor;
  });
}
async function loadStats(more = false) {
  if (!more) {
    stats.value = [];
    statCursor.value = null;
  }
  await run(async (version) => {
    const params = query(more ? statCursor.value : null);
    if (roomId.value) params.set('roomId', roomId.value);
    const result = await session.request<components['schemas']['BookingStatisticsPage']>(
      '/api/v1/statistics/bookings?' + params,
    );
    if (version !== generation) return;
    stats.value = more ? [...stats.value, ...result.items] : result.items;
    statCursor.value = result.nextCursor;
  });
}
async function loadPolicy() {
  await run(async (version) => {
    const result = await session.request<components['schemas']['BookingPolicy']>(
      '/api/v1/settings/booking-policy',
    );
    if (version === generation) policy.value = result;
  });
}
async function savePolicy() {
  if (!policy.value) return;
  const body = JSON.stringify(policy.value);
  const key = keys.get(body) ?? crypto.randomUUID();
  keys.set(body, key);
  await run(async (version) => {
    const result = await session.request<components['schemas']['BookingPolicy']>(
      '/api/v1/settings/booking-policy',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body,
      },
    );
    if (version !== generation) return;
    policy.value = result;
    keys.delete(body);
    notice.value = '规则已保存，仅影响此后创建的新预约；旧预约按创建时的规则处理。';
  });
}
function clear() {
  generation++;
  code.value = undefined;
  policy.value = undefined;
  rooms.value = [];
  reasons.value = [];
  stats.value = [];
  roomCursor.value = null;
  reasonCursor.value = null;
  statCursor.value = null;
  keys.clear();
}
watch([roomId, start, end], () => {
  generation++;
  code.value = undefined;
  reasons.value = [];
  stats.value = [];
  reasonCursor.value = null;
  statCursor.value = null;
});
watch(
  () => session.loggedIn,
  (value) => {
    if (!value) {
      clear();
      void router.replace('/login');
    }
  },
);
onMounted(async () => {
  if (!session.loggedIn) {
    await router.replace('/login');
    return;
  }
  dayTimer = setInterval(() => {
    if (code.value && code.value.date !== shanghaiDay()) {
      code.value = undefined;
      notice.value = '北京时间日期已变化，请重新获取今天的签到码。';
    }
  }, 10000);
  if (management.value && can('d.rooms.read')) await loadRooms();
  await loadPolicy();
});
onUnmounted(() => {
  clear();
  if (dayTimer) clearInterval(dayTimer);
});
</script>

<template>
  <header class="page-header">
    <p class="eyebrow">BOOKING OPERATIONS</p>
    <h1>预约管理与规则</h1>
    <p>查询授权教室的签到码、占用来源与预约统计。全体用户可以查看预约规则。</p>
  </header>
  <p v-if="error" role="alert" class="form-error">{{ error }}</p>
  <p v-if="notice" role="status">{{ notice }}</p>
  <section v-if="management" class="panel operations-panel">
    <h2>教室与签到展示</h2>
    <p class="muted">
      目录可见范围与管理权限可能不同，所有管理查询仍由后端核对院系或指定教室范围。
    </p>
    <div class="booking-search">
      <label v-if="can('d.rooms.read')"
        >教室
        <select v-model="roomId" :disabled="busy">
          <option value="">全部（仅统计）</option>
          <option v-for="room in rooms" :key="room.id" :value="room.id">
            {{ room.name }} · {{ room.code }}
          </option>
        </select>
      </label>
      <label v-else>教室编号<input v-model="roomId" maxlength="100" :disabled="busy" /></label>
      <button v-if="roomCursor" class="secondary-button" :disabled="busy" @click="loadRooms(true)">
        更多教室
      </button>
      <button
        v-if="can('m1.checkin-code.display')"
        class="secondary-button"
        :disabled="busy || !roomId"
        @click="showCode()"
      >
        查看今天签到码
      </button>
    </div>
    <div v-if="code" class="notice check-in-display">
      <p>教室：{{ code.roomId }} · 北京日期：{{ code.date }}</p>
      <strong>{{ code.code }}</strong>
      <p>仅在教室现场展示；跨天需要重新获取。</p>
    </div>
    <h2>时段与查询</h2>
    <div class="booking-search">
      <label
        >开始时间<input v-model="start" type="datetime-local" step="3600" required :disabled="busy"
      /></label>
      <label
        >结束时间<input v-model="end" type="datetime-local" step="3600" required :disabled="busy"
      /></label>
      <button
        v-if="can('m1.resource-reasons.read')"
        class="secondary-button"
        :disabled="busy || !roomId || !start || !end"
        @click="loadReasons()"
      >
        查询占用来源
      </button>
      <button
        v-if="can('m1.statistics.read')"
        class="secondary-button"
        :disabled="busy || !start || !end"
        @click="loadStats()"
      >
        查询预约统计
      </button>
    </div>
    <p class="muted">按北京时间整点查询，最多31天；结束时间不包含在区间内。</p>
    <template v-if="can('m1.resource-reasons.read')">
      <h2>时段来源记录</h2>
      <p class="muted">包含个人预约、整室申请和维修来源，也保留已取消或已释放记录。</p>
      <article v-for="item in reasons" :key="item.sourceModule + item.sourceId" class="booking-row">
        <div>
          <strong>{{ item.sourceModule }} · {{ item.state }}</strong>
          <p>{{ item.reason }}</p>
          <p>
            来源编号：{{ item.sourceId }}<span v-if="item.seatId"> · 座位：{{ item.seatId }}</span>
          </p>
          <p v-if="item.startsAt">{{ format(item.startsAt) }} — {{ format(item.endsAt) }}</p>
        </div>
      </article>
      <button
        v-if="reasonCursor"
        class="secondary-button"
        :disabled="busy"
        @click="loadReasons(true)"
      >
        更多来源
      </button>
    </template>
    <template v-if="can('m1.statistics.read')">
      <h2>个人座位预约统计</h2>
      <p class="muted">
        小时按所选区间截取；签到时长指已签到预约的覆盖时长，不代表实际在座时长。整室申请和维修不计入本表。
      </p>
      <article v-for="item in stats" :key="item.roomId" class="booking-row">
        <div>
          <strong>{{ item.roomName ?? item.roomId }}</strong>
          <p>
            有效预约 {{ item.bookedHours.toFixed(2) }} 座位小时 · 已签到
            {{ item.checkedInHours.toFixed(2) }} 座位小时
          </p>
          <p>
            记录 {{ item.bookingCount ?? '—' }} · 未签到违约 {{ item.noShowCount ?? '—' }} · 取消
            {{ item.cancelledCount ?? '—' }}
          </p>
        </div>
      </article>
      <button v-if="statCursor" class="secondary-button" :disabled="busy" @click="loadStats(true)">
        更多统计
      </button>
    </template>
  </section>
  <section class="panel operations-panel">
    <h2>
      预约规则 <span v-if="policy">· 版本 {{ policy.revision }}</span>
    </h2>
    <button class="secondary-button" :disabled="busy" @click="loadPolicy()">重新读取规则</button>
    <form v-if="policy" class="booking-search" @submit.prevent="savePolicy()">
      <label
        >最多预约小时<input
          v-model.number="policy.maxHours"
          type="number"
          min="1"
          max="24"
          required
          :disabled="busy || !can('d.settings.write')"
      /></label>
      <label
        >签到提前分钟<input
          v-model.number="policy.checkInBeforeMinutes"
          type="number"
          min="0"
          max="60"
          required
          :disabled="busy || !can('d.settings.write')"
      /></label>
      <label
        >提前提醒分钟（0关闭）<input
          v-model.number="policy.reminderBeforeMinutes"
          type="number"
          min="0"
          max="60"
          required
          :disabled="busy || !can('d.settings.write')"
      /></label>
      <label
        >开始后提醒分钟<input
          v-model.number="policy.reminderAfterMinutes"
          type="number"
          min="0"
          max="59"
          required
          :disabled="busy || !can('d.settings.write')"
      /></label>
      <label
        >未签到取消分钟<input
          v-model.number="policy.noShowAfterMinutes"
          type="number"
          min="1"
          max="60"
          required
          :disabled="busy || !can('d.settings.write')"
      /></label>
      <button v-if="can('d.settings.write')" class="primary-button" type="submit" :disabled="busy">
        保存新版本
      </button>
    </form>
    <p class="muted">
      提前提醒设为0表示关闭开始前提醒，开始后提醒仍有效。第二次提醒必须早于自动取消。保存需要全域设置权限；现有预约保持原规则。未签到初版只记录违约，不自动封禁。
    </p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { components } from '@campus/contracts/api';
import { PublicApiError, useSession } from '../d/session';

const session = useSession();
const router = useRouter();
const tomorrow = new Date(Date.now() + 86400000 + 8 * 3600000).toISOString().slice(0, 10);
const start = ref(`${tomorrow}T09:00`);
const end = ref(`${tomorrow}T11:00`);
const power = ref('');
const rooms = ref<components['schemas']['Availability'][]>([]);
const bookings = ref<components['schemas']['Booking'][]>([]);
const cursor = ref<string | null>(null);
const bookingCursor = ref<string | null>(null);
const busy = ref(false);
const saving = ref(false);
const notice = ref('');
const error = ref('');
const keys = new Map<string, string>();
let generation = 0;
function interval() {
  return { startsAt: `${start.value}:00+08:00`, endsAt: `${end.value}:00+08:00` };
}
function fail(failure: unknown) {
  error.value =
    failure instanceof PublicApiError
      ? failure.status === 409
        ? '该时段已不可用或与其他占用冲突，请重新查询'
        : failure.message
      : '请求结果尚未确认，请查看我的预约或用原按钮重试';
}
function key(payload: unknown): string {
  const id = JSON.stringify(payload);
  const previous = keys.get(id);
  if (previous) return previous;
  const next = crypto.randomUUID();
  keys.set(id, next);
  return next;
}
async function history(more = false) {
  const version = generation;
  try {
    const result = await session.request<components['schemas']['BookingPage']>(
      `/api/v1/bookings${more && bookingCursor.value ? `?cursor=${encodeURIComponent(bookingCursor.value)}` : ''}`,
    );
    if (version !== generation) return;
    bookings.value = more ? [...bookings.value, ...result.items] : result.items;
    bookingCursor.value = result.nextCursor;
  } catch (failure) {
    fail(failure);
  }
}
async function search(more = false) {
  if (busy.value) return;
  const version = generation;
  busy.value = true;
  error.value = '';
  try {
    const query = new URLSearchParams(interval());
    if (power.value) query.set('powerType', power.value);
    if (more && cursor.value) query.set('cursor', cursor.value);
    const result = await session.request<components['schemas']['AvailabilityPage']>(
      `/api/v1/availability/seats?${query.toString()}`,
    );
    if (version !== generation) return;
    rooms.value = more ? [...rooms.value, ...result.items] : result.items;
    cursor.value = result.nextCursor;
  } catch (failure) {
    fail(failure);
  } finally {
    busy.value = false;
  }
}
async function reserve(seatId: string) {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  notice.value = '';
  const body = { seatId, ...interval() };
  try {
    await session.request<components['schemas']['Booking']>('/api/v1/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key(['reserve', body]) },
      body: JSON.stringify(body),
    });
    keys.delete(JSON.stringify(['reserve', body]));
    notice.value = '预约已保存';
    await history();
    await search();
  } catch (failure) {
    fail(failure);
  } finally {
    saving.value = false;
  }
}
async function cancel(id: string) {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    await session.request<components['schemas']['Booking']>(
      `/api/v1/bookings/${encodeURIComponent(id)}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key(['cancel', id]) },
        body: JSON.stringify({ reason: '用户主动取消' }),
      },
    );
    keys.delete(JSON.stringify(['cancel', id]));
    notice.value = '预约已取消';
    await history();
  } catch (failure) {
    fail(failure);
  } finally {
    saving.value = false;
  }
}
function format(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
watch([start, end, power], () => {
  rooms.value = [];
  cursor.value = null;
  notice.value = '';
});
watch(
  () => session.loggedIn,
  (value) => {
    if (!value) {
      generation++;
      rooms.value = [];
      bookings.value = [];
      keys.clear();
      void router.replace('/login');
    }
  },
);
onMounted(() => {
  if (session.loggedIn) void history();
  else void router.replace('/login');
});
const powers = { NONE: '无插座', FIXED: '固定插座', RAIL: '移动导轨插座' };
const states: Record<string, string> = {
  BOOKED: '已预约',
  CANCELLED: '已取消',
  CHECKED_IN: '已签到',
  COMPLETED: '已完成',
  NO_SHOW: '未签到取消',
};
</script>

<template>
  <header class="page-header">
    <p class="eyebrow">STUDY SEAT BOOKING</p>
    <h1>预约自习座位</h1>
    <p>时间按北京时间填写。按整点预约，初版默认单次最多 4 小时。</p>
  </header>
  <p class="notice">
    教室须配置开放时间。搜索结果会在提交预约时重新核对；签到、提醒与违约功能尚待接入。
  </p>
  <p v-if="error" role="alert" class="form-error">{{ error }}</p>
  <p v-if="notice" role="status">{{ notice }}</p>
  <section class="panel">
    <form class="booking-search" @submit.prevent="search()">
      <label
        >开始时间<input
          v-model="start"
          type="datetime-local"
          step="3600"
          required
          :disabled="saving || busy"
      /></label>
      <label
        >结束时间<input
          v-model="end"
          type="datetime-local"
          step="3600"
          required
          :disabled="saving || busy"
      /></label>
      <label
        >插座<select v-model="power" :disabled="saving || busy">
          <option value="">不限</option>
          <option value="NONE">无插座</option>
          <option value="FIXED">固定插座</option>
          <option value="RAIL">移动导轨插座</option>
        </select></label
      >
      <button class="primary-button" :disabled="busy || saving" type="submit">
        {{ busy ? '查询中…' : '查找座位' }}
      </button>
    </form>
  </section>
  <section v-if="rooms.length" class="module-grid" aria-label="可用座位">
    <article v-for="item in rooms" :key="item.seat.id" class="panel">
      <span class="module-code">{{ item.room.code }}</span>
      <h2>{{ item.room.name }} · {{ item.seat.code }}</h2>
      <p>{{ powers[item.seat.powerType] }}</p>
      <button class="secondary-button" :disabled="saving" @click="reserve(item.seat.id)">
        预约此座位
      </button>
    </article>
  </section>
  <button v-if="cursor" class="secondary-button" :disabled="busy || saving" @click="search(true)">
    继续查询
  </button>
  <section class="panel" style="margin-top: 24px">
    <div class="panel-heading">
      <h2>我的预约</h2>
      <button class="secondary-button" :disabled="saving" @click="history()">刷新</button>
    </div>
    <p v-if="!bookings.length" class="muted">暂无预约记录。</p>
    <article v-for="item in bookings" :key="item.id" class="booking-row">
      <div>
        <strong>{{ states[item.status] ?? item.status }}</strong>
        <p v-if="item.maintenanceAffected" class="maintenance-warning">
          该时段受教室维修影响，请联系教室管理员；预约记录已保留。
        </p>
        <p>{{ format(item.startsAt) }} — {{ format(item.endsAt) }}</p>
        <p class="muted">座位编号：{{ item.seatId }}</p>
      </div>
      <button
        v-if="item.status === 'BOOKED' && Date.parse(item.startsAt) > Date.now()"
        class="secondary-button"
        :disabled="saving"
        @click="cancel(item.id)"
      >
        取消预约
      </button>
    </article>
    <button v-if="bookingCursor" class="secondary-button" :disabled="saving" @click="history(true)">
      更多预约
    </button>
  </section>
</template>

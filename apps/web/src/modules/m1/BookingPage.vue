<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
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
const codes = ref<Record<string, string>>({});
const historyBusy = ref(false);
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
function canCheckIn(item: components['schemas']['Booking']) {
  const opensAt = item.checkInOpensAt;
  const closesAt = item.checkInClosesAt;
  return (
    item.status === 'BOOKED' &&
    Boolean(opensAt && closesAt) &&
    opensAt !== undefined &&
    closesAt !== undefined &&
    clock.value >= Date.parse(opensAt) &&
    clock.value < Date.parse(closesAt)
  );
}
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
  if (historyBusy.value) return;
  historyBusy.value = true;
  const version = generation;
  try {
    const result = await session.request<components['schemas']['BookingPage']>(
      `/api/v1/bookings${more && bookingCursor.value ? `?cursor=${encodeURIComponent(bookingCursor.value)}` : ''}`,
    );
    if (version !== generation) return;
    bookings.value = more ? [...bookings.value, ...result.items] : result.items;
    bookingCursor.value = result.nextCursor;
  } catch (failure) {
    if (version === generation) fail(failure);
  } finally {
    historyBusy.value = false;
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
  const version = generation;
  try {
    await session.request<components['schemas']['Booking']>('/api/v1/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key(['reserve', body]) },
      body: JSON.stringify(body),
    });
    if (version !== generation) return;
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
  const version = generation;
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
    if (version !== generation) return;
    keys.delete(JSON.stringify(['cancel', id]));
    notice.value = '预约已取消';
    await history();
  } catch (failure) {
    fail(failure);
  } finally {
    saving.value = false;
  }
}
async function checkIn(item: components['schemas']['Booking']) {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  notice.value = '';
  const version = generation;
  const body = { code: (codes.value[item.id] ?? '').trim().toUpperCase() };
  const payload = ['check-in', item.id, body];
  try {
    await session.request('/api/v1/bookings/' + encodeURIComponent(item.id) + '/check-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key(payload) },
      body: JSON.stringify(body),
    });
    if (version !== generation) return;
    keys.delete(JSON.stringify(payload));
    delete codes.value[item.id];
    notice.value = '签到已确认';
    await history();
  } catch (failure) {
    if (version === generation) {
      fail(failure);
      if (failure instanceof PublicApiError && failure.status === 400)
        error.value = '请核对当天、本教室的8位签到码';
      if (failure instanceof PublicApiError && failure.status === 409)
        error.value = '教室可能处于维修或停用状态，请刷新记录并联系管理员';
    }
  } finally {
    saving.value = false;
  }
}
async function repeat(item: components['schemas']['Booking']) {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  notice.value = '';
  const version = generation;
  const body = interval();
  const payload = ['repeat', item.id, body];
  try {
    await session.request('/api/v1/bookings/' + encodeURIComponent(item.id) + '/repeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key(payload) },
      body: JSON.stringify(body),
    });
    if (version !== generation) return;
    keys.delete(JSON.stringify(payload));
    notice.value = '已按上方所选新时段再次预约原座位';
    await history();
    await search();
  } catch (failure) {
    if (version === generation) fail(failure);
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
      codes.value = {};
      void router.replace('/login');
    }
  },
);
onMounted(() => {
  clockTimer = setInterval(() => {
    clock.value = Date.now();
  }, 1000);
  if (session.loggedIn) void history();
  else void router.replace('/login');
});
onUnmounted(() => {
  generation++;
  if (clockTimer) clearInterval(clockTimer);
  codes.value = {};
  keys.clear();
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
    到达后输入管理员在教室展示的当天签到码。默认开始前15分钟可签到、开始后15分钟截止，以每条预约的窗口为准。提醒请查看“我的通知”；初版违约不自动封禁账号。
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
      <button class="secondary-button" :disabled="saving || historyBusy" @click="history()">
        刷新
      </button>
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
        <p v-if="item.checkInOpensAt && item.checkInClosesAt">
          签到窗口：{{ format(item.checkInOpensAt) }} —
          {{ format(item.checkInClosesAt) }}（截止时刻不含）
        </p>
        <p v-if="item.checkedInAt">签到时间：{{ format(item.checkedInAt) }}</p>
        <p v-if="item.cancelReason">{{ item.cancelReason }}</p>
        <p v-if="item.violationAt" class="form-error">本次记录一次未签到违约。</p>
        <form
          v-if="item.status === 'BOOKED'"
          class="booking-search"
          @submit.prevent="checkIn(item)"
        >
          <label
            >当天教室码
            <input
              v-model="codes[item.id]"
              minlength="8"
              maxlength="8"
              required
              autocomplete="off"
              spellcheck="false"
              :disabled="saving || !canCheckIn(item)"
            />
          </label>
          <button class="primary-button" type="submit" :disabled="saving || !canCheckIn(item)">
            签到
          </button>
          <span v-if="!canCheckIn(item)" class="muted"
            >当前不在签到窗口；服务端会再次核对时间。</span
          >
        </form>
        <button class="secondary-button" :disabled="saving" @click="repeat(item)">
          按上方新时段再约原座位
        </button>
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

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { components } from '@campus/contracts/api';
import { PublicApiError, useSession } from './session';
type Room = components['schemas']['Room'];
type Seat = components['schemas']['Seat'];
const session = useSession();
const router = useRouter();
const rooms = ref<Room[]>([]);
const seats = ref<Seat[]>([]);
const selected = ref<Room>();
const cursor = ref<string | null>(null);
const seatCursor = ref<string | null>(null);
const busy = ref(false);
const seatBusy = ref(false);
const error = ref('');
let generation = 0;
function showError(failure: unknown): void {
  error.value = failure instanceof PublicApiError ? failure.message : '暂时无法连接服务，请重试';
}
async function loadRooms(more = false): Promise<void> {
  if (busy.value) return;
  const version = generation;
  busy.value = true;
  error.value = '';
  try {
    const query = more && cursor.value ? `?cursor=${encodeURIComponent(cursor.value)}` : '';
    const result = await session.request<components['schemas']['RoomPage']>(
      `/api/v1/rooms${query}`,
    );
    if (version !== generation) return;
    rooms.value = more ? [...rooms.value, ...result.items] : result.items;
    cursor.value = result.nextCursor;
  } catch (failure) {
    showError(failure);
  } finally {
    busy.value = false;
  }
}
async function loadSeats(room: Room, more = false): Promise<void> {
  if (seatBusy.value) return;
  const version = generation;
  if (!more) {
    selected.value = room;
    seats.value = [];
    seatCursor.value = null;
  }
  seatBusy.value = true;
  error.value = '';
  try {
    const query = more && seatCursor.value ? `?cursor=${encodeURIComponent(seatCursor.value)}` : '';
    const result = await session.request<components['schemas']['SeatPage']>(
      `/api/v1/rooms/${encodeURIComponent(room.id)}/seats${query}`,
    );
    if (version !== generation) return;
    seats.value = more ? [...seats.value, ...result.items] : result.items;
    seatCursor.value = result.nextCursor;
  } catch (failure) {
    showError(failure);
  } finally {
    seatBusy.value = false;
  }
}
watch(
  () => session.loggedIn,
  (loggedIn) => {
    if (!loggedIn) {
      generation++;
      rooms.value = [];
      seats.value = [];
      selected.value = undefined;
      void router.replace('/login');
    }
  },
);
onMounted(() => {
  if (session.loggedIn) void loadRooms();
  else void router.replace('/login');
});
const powers = { NONE: '无插座', FIXED: '固定插座', RAIL: '移动导轨插座' };
</script>

<template>
  <header class="page-header">
    <p class="eyebrow">RESOURCE DIRECTORY</p>
    <h1>教室与座位</h1>
    <p>当前账号：{{ session.user?.displayName }}。仅显示后端授权范围内的目录。</p>
  </header>
  <p class="notice">本页展示资源登记信息。预约可用性查询和预约操作将在 M1 接入后提供。</p>
  <p v-if="error" role="alert" class="form-error">{{ error }}</p>
  <div class="panel-heading">
    <h2>可查看的教室</h2>
    <button class="secondary-button" :disabled="busy" @click="loadRooms()">
      {{ busy ? '读取中…' : '刷新' }}
    </button>
  </div>
  <p v-if="!busy && !rooms.length" class="muted">当前范围内没有可查看的教室。</p>
  <section class="module-grid" aria-label="教室目录">
    <article v-for="room in rooms" :key="room.id" class="panel">
      <span class="module-code">{{ room.code }}</span>
      <h2>{{ room.name }}</h2>
      <p>
        {{ room.enabled ? '已启用' : '已停用' }} ·
        {{ room.restrictedToDepartment ? '院系专用' : '公共空间' }}
      </p>
      <button class="secondary-button" :disabled="seatBusy" @click="loadSeats(room)">
        查看座位
      </button>
    </article>
  </section>
  <button v-if="cursor" class="secondary-button" :disabled="busy" @click="loadRooms(true)">
    加载更多教室
  </button>
  <section v-if="selected" class="panel" aria-live="polite">
    <h2>{{ selected.name }} · 座位</h2>
    <p v-if="seatBusy">正在读取座位…</p>
    <p v-else-if="!seats.length" class="muted">尚未登记座位。</p>
    <div class="seat-list">
      <div v-for="seat in seats" :key="seat.id" class="seat-item">
        <strong>{{ seat.code }}</strong
        ><span>{{ powers[seat.powerType] }}</span
        ><span>{{ seat.enabled ? '已启用' : '已停用' }}</span>
      </div>
    </div>
    <button
      v-if="seatCursor"
      class="secondary-button"
      :disabled="seatBusy"
      @click="loadSeats(selected, true)"
    >
      加载更多座位
    </button>
  </section>
</template>

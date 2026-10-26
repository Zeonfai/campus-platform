<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  useAdminApi,
  useDraftRevision,
  mergeItems,
  type Department,
  type Room,
  type Seat,
  type Page,
  type OpeningSchedule,
} from './admin-api';
const api = useAdminApi();
const rooms = ref<Room[]>([]),
  departments = ref<Department[]>([]),
  seats = ref<Seat[]>([]);
const roomCursor = ref<string | null>(null),
  seatCursor = ref<string | null>(null);
const roomEditing = ref(''),
  roomCode = ref(''),
  roomName = ref(''),
  roomDepartment = ref(''),
  roomRestricted = ref(false),
  roomEnabled = ref(true);
const selectedId = ref(''),
  seatEditing = ref(''),
  seatCode = ref(''),
  seatPower = ref<Seat['powerType']>('NONE'),
  seatEnabled = ref(true);
const schedule = ref<OpeningSchedule>(),
  weekdays = ref<number[]>([]),
  opensAt = ref('08:00'),
  closesAt = ref('22:00');
const selectedRoom = computed(() => rooms.value.find((item) => item.id === selectedId.value));
const roomVersion = useDraftRevision();
const seatVersion = useDraftRevision();
const openingVersion = useDraftRevision();
const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const powers = { NONE: '无插座', FIXED: '固定插座', RAIL: '移动导轨插座' };
async function fetchRooms(more = false) {
  const q = new URLSearchParams();
  if (more && roomCursor.value) q.set('cursor', roomCursor.value);
  const page = await api.read<Page<Room>>('/api/v1/rooms?' + q);
  rooms.value = more ? mergeItems(rooms.value, page.items) : page.items;
  roomCursor.value = page.nextCursor;
}
async function fetchSeats(more = false) {
  if (!selectedId.value) return;
  const q = new URLSearchParams();
  if (more && seatCursor.value) q.set('cursor', seatCursor.value);
  const page = await api.read<Page<Seat>>(
    '/api/v1/rooms/' + encodeURIComponent(selectedId.value) + '/seats?' + q,
  );
  seats.value = more ? mergeItems(seats.value, page.items) : page.items;
  seatCursor.value = page.nextCursor;
}
async function fetchSchedule(copy = true) {
  if (!selectedId.value) return;
  schedule.value = await api.read<OpeningSchedule>(
    '/api/v1/rooms/' + encodeURIComponent(selectedId.value) + '/opening-rules',
  );
  if (copy) {
    openingVersion.reset();
    if (!openingVersion.begin(schedule.value.revision)) {
      api.error.value = '缺少开放规则当前版本，请重新读取。';
      return;
    }
    weekdays.value = [...new Set(schedule.value.rules.map((rule) => rule.weekday))];
    const first = schedule.value.rules[0];
    opensAt.value = first ? String(first.opensHour).padStart(2, '0') + ':00' : '08:00';
    closesAt.value = first ? String(first.closesHour).padStart(2, '0') + ':00' : '22:00';
  }
}
async function selectRoom(room: Room) {
  if (api.busy.value) return;
  selectedId.value = room.id;
  seats.value = [];
  seatCursor.value = null;
  schedule.value = undefined;
  openingVersion.reset();
  resetSeat();
  await api.run(async () => {
    await fetchSeats();
    await fetchSchedule();
  });
}
function resetRoom() {
  roomVersion.reset();
  roomEditing.value = '';
  roomCode.value = '';
  roomName.value = '';
  roomDepartment.value = '';
  roomRestricted.value = false;
  roomEnabled.value = true;
}
function editRoom(room: Room) {
  if (!roomVersion.begin(room.revision)) {
    api.error.value = '缺少教室版本，请重新读取后选择。';
    return;
  }
  roomEditing.value = room.id;
  roomCode.value = room.code;
  roomName.value = room.name;
  roomDepartment.value = room.departmentId ?? '';
  roomRestricted.value = room.restrictedToDepartment;
  roomEnabled.value = room.enabled;
}
function resetSeat() {
  seatVersion.reset();
  seatEditing.value = '';
  seatCode.value = '';
  seatPower.value = 'NONE';
  seatEnabled.value = true;
}
function editSeat(seat: Seat) {
  if (!seatVersion.begin(seat.revision)) {
    api.error.value = '缺少座位版本，请重新读取后选择。';
    return;
  }
  seatEditing.value = seat.id;
  seatCode.value = seat.code;
  seatPower.value = seat.powerType;
  seatEnabled.value = seat.enabled;
}
async function saveRoom() {
  if (roomEditing.value && !roomVersion.ready.value) {
    api.error.value = '教室草稿已失效，请从最新列表重新选择教室，再进行修改。';
    return;
  }
  if (roomRestricted.value && !roomDepartment.value) {
    api.error.value = '院系专用教室必须选择所属院系。';
    return;
  }
  const id = roomEditing.value;
  const payload = {
    code: roomCode.value.trim(),
    name: roomName.value.trim(),
    departmentId: roomDepartment.value || null,
    restrictedToDepartment: roomRestricted.value,
    enabled: roomEnabled.value,
    ...(id ? { expectedRevision: roomVersion.revision.value } : {}),
  };
  await api.mutate<Room>(
    '/api/v1/rooms' + (id ? '/' + encodeURIComponent(id) : ''),
    id ? 'PATCH' : 'POST',
    payload,
    async () => {
      resetRoom();
      await fetchRooms();
      if (selectedId.value === id) await fetchSchedule(false);
    },
    async () => {
      if (roomEditing.value) roomVersion.invalidate();
      await fetchRooms();
    },
  );
}
async function saveSeat() {
  if (!selectedId.value) return;
  if (seatEditing.value && !seatVersion.ready.value) {
    api.error.value = '座位草稿已失效，请从最新列表重新选择座位，再进行修改。';
    return;
  }
  const payload = {
    code: seatCode.value.trim(),
    powerType: seatPower.value,
    enabled: seatEnabled.value,
    ...(seatEditing.value ? { expectedRevision: seatVersion.revision.value } : {}),
  };
  await api.mutate<Seat>(
    seatEditing.value
      ? '/api/v1/seats/' + encodeURIComponent(seatEditing.value)
      : '/api/v1/rooms/' + encodeURIComponent(selectedId.value) + '/seats',
    seatEditing.value ? 'PATCH' : 'POST',
    payload,
    async () => {
      resetSeat();
      await fetchSeats();
    },
    async () => {
      if (seatEditing.value) seatVersion.invalidate();
      await fetchSeats();
    },
  );
}
async function saveSchedule() {
  if (!selectedId.value || !openingVersion.ready.value) {
    api.error.value = '开放规则草稿尚未载入或已失效，请点击“重新读取”后再修改。';
    return;
  }
  const payload = {
    weekdays: [...weekdays.value].sort((a, b) => a - b),
    opensAt: opensAt.value,
    closesAt: closesAt.value,
    timezone: 'Asia/Shanghai',
    expectedRevision: openingVersion.revision.value,
  };
  await api.mutate<OpeningSchedule>(
    '/api/v1/rooms/' + encodeURIComponent(selectedId.value) + '/opening-rules',
    'PUT',
    payload,
    async () => {
      await fetchSchedule();
      await fetchRooms();
    },
    async () => {
      openingVersion.invalidate();
      await fetchSchedule(false);
      await fetchRooms();
    },
  );
}
async function refresh() {
  if (api.can('d.rooms.read')) await fetchRooms();
  if (api.can('d.departments.read'))
    departments.value = await api.all<Department>('/api/v1/departments');
}
api.onClear(() => {
  rooms.value = [];
  departments.value = [];
  seats.value = [];
  roomCursor.value = null;
  seatCursor.value = null;
  selectedId.value = '';
  schedule.value = undefined;
  openingVersion.reset();
  weekdays.value = [];
  resetRoom();
  resetSeat();
});
onMounted(() => void api.run(refresh));
</script>
<template>
  <p v-if="api.error.value" role="alert" class="form-error">{{ api.error.value }}</p>
  <p v-if="api.notice.value" role="status">{{ api.notice.value }}</p>
  <section class="panel admin-panel">
    <div class="panel-heading">
      <h2>教室</h2>
      <button class="secondary-button" :disabled="api.busy.value" @click="api.run(refresh)">
        刷新目录
      </button>
    </div>
    <p class="muted">
      停用会阻止新的资源分配，已有预约与历史记录保留。院系归属和专用设置创建后固定。
    </p>
    <p v-if="!api.busy.value && !rooms.length" class="muted">
      当前没有可管理的教室；只持写权限的账号可在下方登记新教室。
    </p>
    <article v-for="room in rooms" :key="room.id" class="booking-row">
      <div>
        <strong>{{ room.code }} · {{ room.name }}</strong>
        <p>
          {{ room.enabled ? '已启用' : '已停用' }} ·
          {{ room.restrictedToDepartment ? '院系专用' : '公共空间' }} · 版本
          {{ room.revision ?? '待重新读取' }}
        </p>
      </div>
      <div class="admin-actions">
        <button
          v-if="api.can('d.rooms.read')"
          class="secondary-button"
          :disabled="api.busy.value"
          @click="selectRoom(room)"
        >
          座位与开放时间</button
        ><button
          v-if="api.can('d.rooms.write')"
          class="secondary-button"
          :disabled="api.busy.value"
          @click="editRoom(room)"
        >
          编辑教室
        </button>
      </div>
    </article>
    <button
      v-if="roomCursor"
      class="secondary-button"
      :disabled="api.busy.value"
      @click="api.run(() => fetchRooms(true))"
    >
      更多教室
    </button>
  </section>
  <section v-if="api.can('d.rooms.write')" class="panel admin-panel">
    <h2>{{ roomEditing ? '编辑教室' : '登记教室' }}</h2>
    <p v-if="roomVersion.stale.value" class="form-error">
      当前教室输入仅保留作对照。请在最新列表重新点击“编辑教室”，载入最新记录后再保存。
    </p>
    <form class="admin-form" @submit.prevent="saveRoom">
      <label
        >教室编号<input
          v-model="roomCode"
          required
          maxlength="200"
          :disabled="api.busy.value" /></label
      ><label
        >教室名称<input v-model="roomName" required maxlength="200" :disabled="api.busy.value"
      /></label>
      <label
        >所属院系<select
          v-model="roomDepartment"
          :disabled="api.busy.value || Boolean(roomEditing)"
        >
          <option value="">不指定院系</option>
          <option v-for="item in departments" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select></label
      >
      <label class="admin-check"
        ><input
          v-model="roomRestricted"
          type="checkbox"
          :disabled="api.busy.value || Boolean(roomEditing)"
        />仅对所属院系开放</label
      ><label class="admin-check"
        ><input v-model="roomEnabled" type="checkbox" :disabled="api.busy.value" />启用教室</label
      >
      <p v-if="roomEditing" class="muted">
        初版不修改既有教室的归属和专用范围，避免影响已有审批或工单。需新归属时登记新教室并安排停用旧教室。
      </p>
      <div class="admin-actions">
        <button
          class="primary-button"
          type="submit"
          :disabled="
            api.busy.value ||
            !roomCode.trim() ||
            !roomName.trim() ||
            (Boolean(roomEditing) && !roomVersion.ready.value)
          "
        >
          保存教室</button
        ><button
          v-if="roomEditing"
          class="secondary-button"
          type="button"
          :disabled="api.busy.value"
          @click="resetRoom"
        >
          改为新建
        </button>
      </div>
    </form>
  </section>
  <section v-if="selectedId" class="panel admin-panel">
    <div class="panel-heading">
      <h2>{{ selectedRoom?.name ?? selectedId }} · 座位</h2>
      <button
        class="secondary-button"
        :disabled="api.busy.value"
        @click="api.run(() => fetchSeats())"
      >
        刷新座位
      </button>
    </div>
    <p v-if="!api.busy.value && !seats.length" class="muted">尚未登记座位。</p>
    <article v-for="seat in seats" :key="seat.id" class="booking-row">
      <div>
        <strong>{{ seat.code }}</strong>
        <p>{{ powers[seat.powerType] }} · {{ seat.enabled ? '已启用' : '已停用' }}</p>
      </div>
      <button
        v-if="api.can('d.rooms.write')"
        class="secondary-button"
        :disabled="api.busy.value"
        @click="editSeat(seat)"
      >
        编辑座位
      </button>
    </article>
    <button
      v-if="seatCursor"
      class="secondary-button"
      :disabled="api.busy.value"
      @click="api.run(() => fetchSeats(true))"
    >
      更多座位
    </button>
    <form v-if="api.can('d.rooms.write')" class="admin-form" @submit.prevent="saveSeat">
      <h3>{{ seatEditing ? '编辑座位' : '登记座位' }}</h3>
      <p v-if="seatVersion.stale.value" class="form-error">
        座位草稿已失效，当前输入仍保留。请从最新列表重新点击“编辑座位”后再修改。
      </p>
      <label
        >座位编号<input
          v-model="seatCode"
          required
          maxlength="200"
          :disabled="api.busy.value" /></label
      ><label
        >插座类型<select v-model="seatPower" :disabled="api.busy.value">
          <option v-for="(label, value) in powers" :key="value" :value="value">{{ label }}</option>
        </select></label
      ><label class="admin-check"
        ><input v-model="seatEnabled" type="checkbox" :disabled="api.busy.value" />启用座位</label
      >
      <div class="admin-actions">
        <button
          class="primary-button"
          type="submit"
          :disabled="
            api.busy.value || !seatCode.trim() || (Boolean(seatEditing) && !seatVersion.ready.value)
          "
        >
          保存座位</button
        ><button
          v-if="seatEditing"
          class="secondary-button"
          type="button"
          :disabled="api.busy.value"
          @click="resetSeat"
        >
          改为新建
        </button>
      </div>
    </form>
  </section>
  <section v-if="selectedId" class="panel admin-panel">
    <div class="panel-heading">
      <h2>每周开放时间</h2>
      <button
        class="secondary-button"
        :disabled="api.busy.value"
        @click="api.run(() => fetchSchedule())"
      >
        重新读取
      </button>
    </div>
    <p class="notice">
      保存将替换整周配置：只开放勾选的星期，每天同一个整点时段。全部不勾选表示整周关闭；时间按北京时间。已有预约保留，不会自动取消。
    </p>
    <p v-if="openingVersion.stale.value" class="form-error">
      开放时间草稿已失效，当前输入仍保留。请点击“重新读取”载入最新整周配置后再修改和保存。
    </p>
    <p v-if="schedule" class="muted">
      当前版本 {{ schedule.revision }}：{{
        schedule.rules.length
          ? schedule.rules
              .map(
                (rule) =>
                  (dayNames[rule.weekday - 1] ?? rule.weekday) +
                  ' ' +
                  String(rule.opensHour).padStart(2, '0') +
                  ':00–' +
                  String(rule.closesHour).padStart(2, '0') +
                  ':00',
              )
              .join('；')
          : '整周关闭'
      }}
    </p>
    <form v-if="api.can('d.rooms.write')" class="admin-form" @submit.prevent="saveSchedule">
      <fieldset :disabled="api.busy.value">
        <legend>开放星期</legend>
        <div class="admin-options">
          <label v-for="(label, index) in dayNames" :key="index"
            ><input v-model="weekdays" type="checkbox" :value="index + 1" />{{ label }}</label
          >
        </div>
      </fieldset>
      <div class="booking-search">
        <label
          >每天开始<input
            v-model="opensAt"
            required
            pattern="([01][0-9]|2[0-3]):00"
            placeholder="08:00"
            :disabled="api.busy.value" /></label
        ><label
          >每天结束<input
            v-model="closesAt"
            required
            pattern="([01][0-9]|2[0-3]):00|24:00"
            placeholder="22:00"
            :disabled="api.busy.value"
        /></label>
      </div>
      <button
        class="primary-button"
        type="submit"
        :disabled="api.busy.value || !openingVersion.ready.value"
      >
        替换整周开放时间
      </button>
    </form>
  </section>
</template>

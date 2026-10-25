<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  useAdminApi,
  useDraftRevision,
  mergeItems,
  scopeLabel,
  type ManagedUser,
  type Role,
  type Room,
  type Page,
} from './admin-api';
const api = useAdminApi();
const items = ref<ManagedUser[]>([]),
  roles = ref<Role[]>([]),
  rooms = ref<Room[]>([]);
const cursor = ref<string | null>(null),
  editing = ref(''),
  selectedRoles = ref<string[]>([]),
  managedRooms = ref<string[]>([]),
  enabled = ref(true),
  reason = ref('');
const draftVersion = useDraftRevision();
const current = computed(() => items.value.find((item) => item.id === editing.value));
const ownAccount = computed(() => editing.value === api.session.user?.id);
const catalogsReady = ref(false);
async function fetchItems(more = false) {
  const q = new URLSearchParams();
  if (more && cursor.value) q.set('cursor', cursor.value);
  const page = await api.read<Page<ManagedUser>>('/api/v1/users?' + q);
  items.value = more ? mergeItems(items.value, page.items) : page.items;
  cursor.value = page.nextCursor;
}
async function refresh() {
  if (api.can('d.users.read')) await fetchItems();
  if (api.can('d.users.write') && api.can('d.roles.read') && api.can('d.rooms.read')) {
    roles.value = await api.all<Role>('/api/v1/roles');
    rooms.value = await api.all<Room>('/api/v1/rooms');
    catalogsReady.value = true;
  }
}
function reset() {
  draftVersion.reset();
  editing.value = '';
  selectedRoles.value = [];
  managedRooms.value = [];
  enabled.value = true;
  reason.value = '';
}
function edit(item: ManagedUser) {
  if (
    !Array.isArray(item.roleIds) ||
    !Array.isArray(item.managedRoomIds) ||
    !draftVersion.begin(item.revision)
  ) {
    api.error.value = '授权信息不完整，请先重新读取用户列表。';
    return;
  }
  editing.value = item.id;
  selectedRoles.value = [...(item.roleIds ?? [])];
  managedRooms.value = [...(item.managedRoomIds ?? [])];
  enabled.value = item.enabled;
  reason.value = '';
}
async function save() {
  if (!draftVersion.ready.value) {
    api.error.value = '授权草稿已失效，请从最新列表重新选择用户，再对照权限进行修改。';
    return;
  }
  if (ownAccount.value) {
    api.error.value = '请由另一位有权限的管理员修改当前账号。';
    return;
  }
  const payload = {
    roleIds: [...selectedRoles.value].sort(),
    managedRoomIds: [...managedRooms.value].sort(),
    enabled: enabled.value,
    reason: reason.value.trim(),
    expectedRevision: draftVersion.revision.value,
  };
  await api.mutate<ManagedUser>(
    '/api/v1/users/' + encodeURIComponent(editing.value) + '/access',
    'PUT',
    payload,
    async () => {
      reset();
      await fetchItems();
      api.notice.value = '访问权限已保存，对方原有会话已撤销，需要重新登录。';
    },
    async () => {
      draftVersion.invalidate();
      await fetchItems();
    },
  );
}
api.onClear(() => {
  items.value = [];
  roles.value = [];
  rooms.value = [];
  cursor.value = null;
  catalogsReady.value = false;
  reset();
});
onMounted(() => void api.run(refresh));
</script>
<template>
  <section class="panel admin-panel">
    <div class="panel-heading">
      <h2>用户访问权限</h2>
      <button class="secondary-button" :disabled="api.busy.value" @click="api.run(refresh)">
        刷新用户与选项
      </button>
    </div>
    <p v-if="api.error.value" role="alert" class="form-error">{{ api.error.value }}</p>
    <p v-if="api.notice.value" role="status">{{ api.notice.value }}</p>
    <p class="muted">
      此处管理已有账号，不显示密码。停用或访问范围变更会撤销原会话，对方需要重新登录。这也可能影响该用户正在处理的审批或维修，请先安排交接。当前账号的授权需由另一位管理员修改。
    </p>
    <p v-if="!api.busy.value && !items.length" class="muted">当前没有可显示的用户。</p>
    <article v-for="item in items" :key="item.id" class="booking-row">
      <div>
        <strong
          >{{ item.displayName }}
          <span v-if="item.id === api.session.user?.id">（当前账号）</span></strong
        >
        <p>
          {{ item.username ?? item.id }} · {{ item.enabled ? '已启用' : '已停用' }} ·
          {{ item.roleIds?.length ?? '—' }}个角色
        </p>
        <p class="muted">编号：{{ item.id }} · 版本 {{ item.revision ?? '待重新读取' }}</p>
      </div>
      <button
        v-if="api.can('d.users.write')"
        class="secondary-button"
        :disabled="api.busy.value || item.id === api.session.user?.id"
        @click="edit(item)"
      >
        调整访问
      </button>
    </article>
    <button
      v-if="cursor"
      class="secondary-button"
      :disabled="api.busy.value"
      @click="api.run(() => fetchItems(true))"
    >
      更多用户
    </button>
  </section>
  <section v-if="editing && api.can('d.users.write')" class="panel admin-panel">
    <h2>调整 {{ current?.displayName ?? editing }} 的访问权限</h2>
    <p v-if="draftVersion.stale.value" class="form-error">
      旧授权输入仍保留作对照，保存已停用。请在最新列表重新点击“调整访问”，载入最新授权后再修改。
    </p>
    <p v-if="!catalogsReady" class="form-error">
      尚未完整读取角色或教室目录。请刷新；编辑需要相应目录读取权限。
    </p>
    <form class="admin-form" @submit.prevent="save">
      <fieldset :disabled="api.busy.value || !catalogsReady || ownAccount">
        <legend>分配角色</legend>
        <div class="admin-options">
          <label v-for="role in roles" :key="role.id"
            ><input v-model="selectedRoles" type="checkbox" :value="role.id" />{{ role.name
            }}<small>{{ scopeLabel(role.scope) }}</small></label
          >
        </div>
      </fieldset>
      <fieldset :disabled="api.busy.value || !catalogsReady || ownAccount">
        <legend>指定管理教室</legend>
        <p class="muted">只有角色本身授予“指定教室”范围的相应操作时，这些教室才生效。</p>
        <div class="admin-options">
          <label v-for="room in rooms" :key="room.id"
            ><input v-model="managedRooms" type="checkbox" :value="room.id" />{{ room.code }} ·
            {{ room.name }}</label
          >
        </div>
      </fieldset>
      <label class="admin-check"
        ><input
          v-model="enabled"
          type="checkbox"
          :disabled="api.busy.value || ownAccount"
        />启用账号</label
      >
      <label
        >调整原因<textarea
          v-model="reason"
          required
          maxlength="1000"
          rows="3"
          :disabled="api.busy.value || ownAccount"
        ></textarea>
      </label>
      <div class="admin-actions">
        <button
          class="primary-button"
          type="submit"
          :disabled="
            api.busy.value ||
            !catalogsReady ||
            ownAccount ||
            !reason.trim() ||
            !draftVersion.ready.value
          "
        >
          保存访问权限</button
        ><button class="secondary-button" type="button" :disabled="api.busy.value" @click="reset">
          取消编辑
        </button>
      </div>
    </form>
  </section>
</template>

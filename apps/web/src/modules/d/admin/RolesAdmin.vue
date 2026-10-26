<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { components } from '@campus/contracts/api';
import {
  useAdminApi,
  useDraftRevision,
  mergeItems,
  scopes,
  scopeLabel,
  type Role,
  type Page,
} from './admin-api';
const api = useAdminApi();
const items = ref<Role[]>([]),
  permissions = ref<components['schemas']['Permission'][]>([]);
const cursor = ref<string | null>(null),
  editing = ref(''),
  name = ref('');
const scope = ref<Role['scope']>('SELF'),
  selected = ref<string[]>([]);
const draftVersion = useDraftRevision();
const groups = computed(() =>
  [...new Set(permissions.value.map((item) => item.id.split('.')[0] ?? '其他'))].map((id) => ({
    id,
    items: permissions.value.filter((item) => item.id.startsWith(id + '.')),
  })),
);
async function fetchItems(more = false) {
  const q = new URLSearchParams();
  if (more && cursor.value) q.set('cursor', cursor.value);
  const page = await api.read<Page<Role>>('/api/v1/roles?' + q);
  items.value = more ? mergeItems(items.value, page.items) : page.items;
  cursor.value = page.nextCursor;
}
function reset() {
  draftVersion.reset();
  editing.value = '';
  name.value = '';
  scope.value = 'SELF';
  selected.value = [];
}
function edit(item: Role) {
  if (!draftVersion.begin(item.revision)) {
    api.error.value = '缺少角色版本，请重新读取后选择。';
    return;
  }
  editing.value = item.id;
  name.value = item.name;
  scope.value = item.scope;
  selected.value = [...item.permissionIds];
}
async function refresh() {
  if (api.can('d.roles.read')) await fetchItems();
  if (api.can('d.roles.write'))
    permissions.value = await api.all<components['schemas']['Permission']>('/api/v1/permissions');
}
async function save() {
  if (editing.value && !draftVersion.ready.value) {
    api.error.value = '草稿版本已失效，请从列表重新选择角色，载入最新权限后再保存。';
    return;
  }
  const payload = {
    name: name.value.trim(),
    scope: scope.value,
    permissionIds: [...selected.value].sort(),
    ...(editing.value ? { expectedRevision: draftVersion.revision.value } : {}),
  };
  await api.mutate<Role>(
    '/api/v1/roles' + (editing.value ? '/' + encodeURIComponent(editing.value) : ''),
    editing.value ? 'PATCH' : 'POST',
    payload,
    async () => {
      reset();
      if (api.can('d.roles.read')) await fetchItems();
      api.notice.value = '角色已保存。受影响用户的访问资格由服务器重新检查，请重新登录刷新菜单。';
    },
    async () => {
      if (editing.value) draftVersion.invalidate();
      if (api.can('d.roles.read')) await fetchItems();
    },
  );
}
api.onClear(() => {
  items.value = [];
  permissions.value = [];
  cursor.value = null;
  reset();
});
onMounted(() => {
  if (api.can('d.roles.read') || api.can('d.roles.write')) void api.run(refresh);
});
</script>
<template>
  <section class="panel admin-panel">
    <div class="panel-heading">
      <h2>角色与权限</h2>
      <button
        v-if="api.can('d.roles.read')"
        class="secondary-button"
        :disabled="api.busy.value"
        @click="api.run(refresh)"
      >
        刷新
      </button>
    </div>
    <p v-if="api.error.value" role="alert" class="form-error">{{ api.error.value }}</p>
    <p v-if="api.notice.value" role="status">{{ api.notice.value }}</p>
    <p class="muted">
      角色配置需要全域管理资格。最后一名有效安全管理员会受到保护。修改角色会撤销受影响成员的会话，他们需要重新登录。
    </p>
    <p v-if="!api.busy.value && !items.length" class="muted">当前没有可显示的角色。</p>
    <article v-for="item in items" :key="item.id" class="booking-row">
      <div>
        <strong>{{ item.name }}</strong>
        <p>{{ scopeLabel(item.scope) }} · {{ item.permissionIds.length }}项权限</p>
        <p class="muted">{{ item.id }} · 版本 {{ item.revision ?? '待重新读取' }}</p>
      </div>
      <button
        v-if="api.can('d.roles.write')"
        class="secondary-button"
        :disabled="api.busy.value"
        @click="edit(item)"
      >
        编辑
      </button>
    </article>
    <button
      v-if="cursor"
      class="secondary-button"
      :disabled="api.busy.value"
      @click="api.run(() => fetchItems(true))"
    >
      更多角色
    </button>
  </section>
  <section v-if="api.can('d.roles.write')" class="panel admin-panel">
    <h2>{{ editing ? '编辑角色' : '创建角色' }}</h2>
    <p v-if="draftVersion.stale.value" class="form-error">
      当前权限草稿仅保留作对照，不能直接保存。请在最新列表重新点击“编辑”，载入最新权限后再修改。
    </p>
    <form class="admin-form" @submit.prevent="save">
      <label
        >角色名称<input v-model="name" required maxlength="200" :disabled="api.busy.value"
      /></label>
      <label
        >数据范围<select v-model="scope" :disabled="api.busy.value">
          <option v-for="item in scopes" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select></label
      >
      <fieldset :disabled="api.busy.value">
        <legend>允许的操作</legend>
        <p v-if="!permissions.length" class="muted">
          请先刷新以读取权限目录。没有读取目录时不能保存权限变更。
        </p>
        <details v-for="group in groups" :key="group.id" open>
          <summary>{{ group.id.toUpperCase() }} 模块</summary>
          <div class="admin-options">
            <label v-for="permission in group.items" :key="permission.id"
              ><input v-model="selected" type="checkbox" :value="permission.id" />{{
                permission.description
              }}<small>{{ permission.id }}</small></label
            >
          </div>
        </details>
      </fieldset>
      <div class="admin-actions">
        <button
          class="primary-button"
          type="submit"
          :disabled="
            api.busy.value ||
            !name.trim() ||
            !permissions.length ||
            (Boolean(editing) && !draftVersion.ready.value)
          "
        >
          保存角色</button
        ><button
          v-if="editing"
          class="secondary-button"
          type="button"
          :disabled="api.busy.value"
          @click="reset"
        >
          改为新建
        </button>
      </div>
    </form>
  </section>
</template>

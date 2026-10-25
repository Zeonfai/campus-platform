<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useAdminApi, useDraftRevision, mergeItems, type Department, type Page } from './admin-api';
const api = useAdminApi();
const items = ref<Department[]>([]),
  cursor = ref<string | null>(null);
const editing = ref(''),
  name = ref('');
const draftVersion = useDraftRevision();
async function fetchItems(more = false) {
  const query = new URLSearchParams();
  if (more && cursor.value) query.set('cursor', cursor.value);
  const page = await api.read<Page<Department>>('/api/v1/departments?' + query);
  items.value = more ? mergeItems(items.value, page.items) : page.items;
  cursor.value = page.nextCursor;
}
function edit(item: Department) {
  if (!draftVersion.begin(item.revision)) {
    api.error.value = '缺少当前版本，请重新读取后选择院系。';
    return;
  }
  editing.value = item.id;
  name.value = item.name;
}
function reset() {
  draftVersion.reset();
  editing.value = '';
  name.value = '';
}
async function save() {
  const payload = {
    name: name.value.trim(),
    ...(editing.value ? { expectedRevision: draftVersion.revision.value } : {}),
  };
  if (editing.value && !draftVersion.ready.value) {
    api.error.value = '草稿版本已失效，请从列表重新选择院系，载入最新数据后再保存。';
    return;
  }
  await api.mutate<Department>(
    '/api/v1/departments' + (editing.value ? '/' + encodeURIComponent(editing.value) : ''),
    editing.value ? 'PATCH' : 'POST',
    payload,
    async () => {
      reset();
      await fetchItems();
    },
    async () => {
      if (editing.value) draftVersion.invalidate();
      await fetchItems();
    },
  );
}
api.onClear(() => {
  items.value = [];
  cursor.value = null;
  reset();
});
onMounted(() => {
  if (api.can('d.departments.read')) void api.run(() => fetchItems());
});
</script>
<template>
  <section class="panel admin-panel">
    <div class="panel-heading">
      <h2>院系列表</h2>
      <button
        v-if="api.can('d.departments.read')"
        class="secondary-button"
        :disabled="api.busy.value"
        @click="api.run(() => fetchItems())"
      >
        刷新
      </button>
    </div>
    <p v-if="api.error.value" role="alert" class="form-error">{{ api.error.value }}</p>
    <p v-if="api.notice.value" role="status">{{ api.notice.value }}</p>
    <p v-if="!api.busy.value && !items.length" class="muted">当前没有可显示的院系。</p>
    <article v-for="item in items" :key="item.id" class="booking-row">
      <div>
        <strong>{{ item.name }}</strong>
        <p class="muted">编号：{{ item.id }} · 版本 {{ item.revision ?? '待重新读取' }}</p>
      </div>
      <button
        v-if="api.can('d.departments.write')"
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
      更多院系
    </button>
  </section>
  <section v-if="api.can('d.departments.write')" class="panel admin-panel">
    <h2>{{ editing ? '编辑院系' : '登记院系' }}</h2>
    <p v-if="draftVersion.stale.value" class="form-error">
      当前输入保留作对照，保存已停用。请在最新列表重新点击“编辑”，载入最新记录后再修改。
    </p>
    <p class="muted">初版保留院系和历史引用，只修改名称。</p>
    <form class="admin-form" @submit.prevent="save">
      <label
        >院系名称<input v-model="name" required maxlength="200" :disabled="api.busy.value"
      /></label>
      <div class="admin-actions">
        <button
          class="primary-button"
          type="submit"
          :disabled="
            api.busy.value || !name.trim() || (Boolean(editing) && !draftVersion.ready.value)
          "
        >
          保存</button
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

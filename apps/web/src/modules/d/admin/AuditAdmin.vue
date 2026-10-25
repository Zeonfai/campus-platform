<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { components } from '@campus/contracts/api';
import { useAdminApi, mergeItems, type Page } from './admin-api';
const api = useAdminApi();
const items = ref<components['schemas']['AuditEvent'][]>([]);
const actorId = ref(''),
  action = ref(''),
  targetId = ref(''),
  cursor = ref<string | null>(null);
async function fetchItems(more = false) {
  const q = new URLSearchParams();
  for (const [name, value] of [
    ['actorId', actorId.value],
    ['action', action.value],
    ['targetId', targetId.value],
  ])
    if (value?.trim()) q.set(name ?? '', value.trim());
  if (more && cursor.value) q.set('cursor', cursor.value);
  const page = await api.read<Page<components['schemas']['AuditEvent']>>(
    '/api/v1/audit-events?' + q,
  );
  items.value = more ? mergeItems(items.value, page.items) : page.items;
  cursor.value = page.nextCursor;
}
watch([actorId, action, targetId], () => {
  items.value = [];
  cursor.value = null;
});
api.onClear(() => {
  items.value = [];
  cursor.value = null;
  actorId.value = '';
  action.value = '';
  targetId.value = '';
});
onMounted(() => void api.run(() => fetchItems()));
</script>
<template>
  <section class="panel admin-panel">
    <h2>操作审计</h2>
    <p class="muted">
      仅全域审计权限可查看。筛选精确匹配；日志保留操作人、对象、时间和追踪编号，不显示密码、令牌或签到码。
    </p>
    <p v-if="api.error.value" role="alert" class="form-error">{{ api.error.value }}</p>
    <form class="booking-search" @submit.prevent="api.run(() => fetchItems())">
      <label>操作人编号<input v-model="actorId" maxlength="100" :disabled="api.busy.value" /></label
      ><label>操作名称<input v-model="action" maxlength="100" :disabled="api.busy.value" /></label
      ><label
        >对象编号<input v-model="targetId" maxlength="100" :disabled="api.busy.value"
      /></label>
      <button class="primary-button" type="submit" :disabled="api.busy.value">查询</button>
    </form>
    <p v-if="!api.busy.value && !items.length" class="muted">当前条件下没有审计记录。</p>
    <article v-for="item in items" :key="item.id" class="booking-row">
      <div>
        <strong>{{ item.action }}</strong>
        <p>操作人：{{ item.actorId }} · 对象：{{ item.targetId }}</p>
        <p v-if="item.reason">原因：{{ item.reason }}</p>
        <p>
          {{
            new Date(item.createdAt).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
              hour12: false,
            })
          }}
        </p>
        <p class="muted">追踪编号：{{ item.traceId }}</p>
      </div>
    </article>
    <button
      v-if="cursor"
      class="secondary-button"
      :disabled="api.busy.value"
      @click="api.run(() => fetchItems(true))"
    >
      更多记录
    </button>
  </section>
</template>

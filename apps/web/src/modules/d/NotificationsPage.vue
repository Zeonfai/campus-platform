<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { components } from '@campus/contracts/api';
import { useSession, PublicApiError } from './session';

const session = useSession();
const router = useRouter();
const items = ref<components['schemas']['Notification'][]>([]);
const cursor = ref<string | null>(null);
const error = ref('');
const busy = ref(false);
const keys = new Map<string, string>();
let generation = 0;

async function load(more = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  const version = generation;
  try {
    const result = await session.request<components['schemas']['NotificationPage']>(
      '/api/v1/notifications' +
        (more && cursor.value ? '?cursor=' + encodeURIComponent(cursor.value) : ''),
    );
    if (version !== generation) return;
    items.value = more ? [...items.value, ...result.items] : result.items;
    cursor.value = result.nextCursor;
  } catch (failure) {
    if (version === generation)
      error.value =
        failure instanceof PublicApiError ? failure.message : '通知暂时加载失败，请重试';
  } finally {
    busy.value = false;
  }
}
async function read(id: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  const version = generation;
  const key = keys.get(id) ?? crypto.randomUUID();
  keys.set(id, key);
  try {
    await session.request('/api/v1/notifications/' + encodeURIComponent(id) + '/read', {
      method: 'POST',
      headers: { 'idempotency-key': key },
    });
    if (version !== generation) return;
    const item = items.value.find((notification) => notification.id === id);
    if (item) item.read = true;
    keys.delete(id);
  } catch (failure) {
    if (version === generation)
      error.value =
        failure instanceof PublicApiError ? failure.message : '已读结果未确认，请用原按钮重试';
  } finally {
    busy.value = false;
  }
}
function clear() {
  generation++;
  items.value = [];
  cursor.value = null;
  keys.clear();
}
watch(
  () => session.loggedIn,
  (value) => {
    if (!value) {
      clear();
      void router.replace('/login');
    }
  },
);
onMounted(() => {
  if (session.loggedIn) void load();
  else void router.replace('/login');
});
onUnmounted(clear);
</script>

<template>
  <header class="page-header">
    <p class="eyebrow">MY NOTIFICATIONS</p>
    <h1>我的通知</h1>
    <p>查看预约提醒与超时处理消息。当前提供站内通知，邮件和微信尚未接入。</p>
  </header>
  <p v-if="error" role="alert" class="form-error">{{ error }}</p>
  <button class="secondary-button" :disabled="busy" @click="load()">刷新通知</button>
  <p v-if="!busy && !items.length" class="muted">暂无通知。</p>
  <section class="notification-list">
    <article v-for="item in items" :key="item.id" class="panel">
      <h2>{{ item.title }} · {{ item.read ? '已读' : '未读' }}</h2>
      <p>{{ item.body }}</p>
      <p class="muted">
        {{ new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}
      </p>
      <button v-if="!item.read" class="secondary-button" :disabled="busy" @click="read(item.id)">
        标记已读
      </button>
    </article>
  </section>
  <button v-if="cursor" class="secondary-button" :disabled="busy" @click="load(true)">
    更多通知
  </button>
</template>

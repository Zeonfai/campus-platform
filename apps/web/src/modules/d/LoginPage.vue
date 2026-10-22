<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { PublicApiError, useSession } from './session';
const session = useSession();
const router = useRouter();
const username = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
async function submit(): Promise<void> {
  if (busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    await session.login(username.value, password.value);
    await router.replace('/directory');
  } catch (failure) {
    error.value =
      failure instanceof PublicApiError ? failure.message : '暂时无法连接，请检查本地服务';
  } finally {
    password.value = '';
    busy.value = false;
  }
}
</script>

<template>
  <header class="page-header">
    <p class="eyebrow">CAMPUS RESOURCE PLATFORM</p>
    <h1>登录校园资源平台</h1>
    <p>使用本地演示账号，查看你的教室和座位目录。</p>
  </header>
  <section class="panel login-panel">
    <form @submit.prevent="submit">
      <label for="username">账号</label>
      <input
        id="username"
        v-model="username"
        name="username"
        autocomplete="username"
        maxlength="200"
        required
        :disabled="busy"
      />
      <label for="password">密码</label>
      <input
        id="password"
        v-model="password"
        name="password"
        type="password"
        autocomplete="current-password"
        maxlength="200"
        required
        :disabled="busy"
      />
      <p v-if="error" role="alert" class="form-error">{{ error }}</p>
      <button class="primary-button" type="submit" :disabled="busy">
        {{ busy ? '正在登录…' : '登录' }}
      </button>
    </form>
    <p class="muted">
      演示账号密码由本地脚本随机生成，读取方式见项目 README。刷新页面后需要重新登录。
    </p>
  </section>
</template>

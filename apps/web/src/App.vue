<script setup lang="ts">
import { modules } from './modules/catalog';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSession } from './modules/d/session';
const session = useSession();
const router = useRouter();
const logoutError = ref('');
const leaving = ref(false);
async function logout(): Promise<void> {
  leaving.value = true;
  logoutError.value = '';
  try {
    await session.logout();
    await router.push('/login');
  } catch {
    logoutError.value = '退出暂未确认，请重试';
  } finally {
    leaving.value = false;
  }
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <RouterLink class="brand" to="/">校园资源<span>服务平台 · 工程预览</span></RouterLink>
      <nav aria-label="主导航">
        <RouterLink to="/">工作区概览</RouterLink>
        <RouterLink v-if="session.loggedIn" to="/bookings">预约自习座位</RouterLink>
        <RouterLink v-if="session.loggedIn" to="/work-orders">物业报修与维修</RouterLink>
        <RouterLink v-if="session.loggedIn" to="/applications">整教室申请与审批</RouterLink>
        <RouterLink :to="session.loggedIn ? '/directory' : '/login'">{{
          session.loggedIn ? '教室与座位' : '登录平台'
        }}</RouterLink>
        <RouterLink v-for="(item, key) in modules" :key="key" :to="`/modules/${key}`">{{
          item.name
        }}</RouterLink>
      </nav>
      <div v-if="session.loggedIn" class="session-summary">
        <p>{{ session.user?.displayName }}</p>
        <button class="secondary-button" :disabled="leaving" @click="logout">
          {{ leaving ? '正在退出…' : '退出登录' }}
        </button>
        <p v-if="logoutError" role="alert">{{ logoutError }}</p>
      </div>
      <p class="sidebar-note">身份、预约、审批和维修已接入<br />签到与管理功能继续完善</p>
    </aside>
    <main class="content"><RouterView /></main>
  </div>
</template>

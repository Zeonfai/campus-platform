<script setup lang="ts">
import { ElAlert, ElButton } from 'element-plus';
import 'element-plus/es/components/alert/style/css.mjs';
import 'element-plus/es/components/button/style/css.mjs';
import { ref } from 'vue';
import { modules } from '../modules/catalog';

const running = ref(false);
const statuses = ref<Record<string, string>>({ core: '尚未检查', workflow: '尚未检查' });
async function checkHealth(): Promise<void> {
  running.value = true;
  try {
    await Promise.all(
      [
        ['core', '/core-health/ready'],
        ['workflow', '/workflow-health/ready'],
      ].map(async ([key, path]) => {
        if (!key || !path) return;
        try {
          const response = await fetch(path, { signal: AbortSignal.timeout(5000) });
          const data: unknown = await response.json();
          const ready =
            response.ok &&
            typeof data === 'object' &&
            data !== null &&
            'status' in data &&
            data.status === 'ready';
          statuses.value[key] = ready ? '服务及数据库基础就绪' : '尚未就绪，请检查配置、迁移和种子';
        } catch {
          statuses.value[key] = '暂时无法连接服务';
        }
      }),
    );
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <header class="page-header">
    <p class="eyebrow">CAMPUS RESOURCE PLATFORM</p>
    <h1>统一入口，清晰分工</h1>
    <p>从公共接口和真实资源状态开始，逐步完成四个业务模块。</p>
  </header>
  <el-alert
    title="登录、目录、预约、申请审批及报修维修已接入真实服务；签到和管理功能继续完善，当前版本待人工验收。"
    type="info"
    :closable="false"
    show-icon
  />
  <section class="module-grid" aria-label="业务模块">
    <RouterLink
      v-for="(item, key) in modules"
      :key="key"
      class="module-card"
      :to="`/modules/${key}`"
    >
      <span class="module-code">{{ String(key).toUpperCase() }}</span>
      <h2>{{ item.name }}</h2>
      <p>{{ item.description }}</p>
      <span class="card-link">查看模块任务 →</span>
    </RouterLink>
  </section>
  <section class="panel">
    <div class="panel-heading">
      <h2>本地运行状态</h2>
      <el-button :loading="running" @click="checkHealth">检查服务</el-button>
    </div>
    <p>resource-core：{{ statuses.core }}</p>
    <p>workflow：{{ statuses.workflow }}</p>
    <p class="muted">仅检查真实后端和数据库基础状态，不模拟业务成功。</p>
  </section>
</template>

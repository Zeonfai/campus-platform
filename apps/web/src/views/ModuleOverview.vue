<script setup lang="ts">
import { ElTag, ElEmpty } from 'element-plus';
import 'element-plus/es/components/tag/style/css.mjs';
import 'element-plus/es/components/empty/style/css.mjs';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { modules, type ModuleKey } from '../modules/catalog';

const route = useRoute();
const key = computed(() => String(route.params.module));
const item = computed(() =>
  Object.hasOwn(modules, key.value) ? modules[key.value as ModuleKey] : undefined,
);
</script>

<template>
  <template v-if="item">
    <header class="page-header">
      <p class="eyebrow">{{ key.toUpperCase() }} · {{ item.service }}</p>
      <h1>{{ item.name }}</h1>
      <p>{{ item.description }}</p>
    </header>
    <section class="panel">
      <h2>首轮交付范围</h2>
      <ul class="task-list">
        <li v-for="task in item.tasks" :key="task">{{ task }}</li>
      </ul>
      <el-tag v-if="['m1', 'm2', 'm3', 'd'].includes(key)" type="success">部分功能已接入</el-tag>
      <el-tag v-else type="info">尚未实现</el-tag>
      <p v-if="key === 'm1'">
        <RouterLink class="card-link" to="/bookings">进入座位预约 →</RouterLink>
      </p>
      <p v-if="key === 'm2'">
        <RouterLink class="card-link" to="/applications">进入整教室申请与审批 →</RouterLink>
      </p>
      <p v-if="key === 'm3'">
        <RouterLink class="card-link" to="/work-orders">进入报修与维修处理 →</RouterLink>
      </p>
      <p v-if="key === 'd'">
        <RouterLink class="card-link" to="/directory">进入教室与座位目录 →</RouterLink>
      </p>
      <p class="muted">
        开始修改前，请让 AI 阅读根 AGENTS.md、本模块规则、需求基线及接口契约。每次提交需要人工验收。
      </p>
    </section>
  </template>
  <el-empty v-else description="模块不存在" />
</template>

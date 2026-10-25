<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSession } from './session';
import DepartmentsAdmin from './admin/DepartmentsAdmin.vue';
import RolesAdmin from './admin/RolesAdmin.vue';
import ResourcesAdmin from './admin/ResourcesAdmin.vue';
import UsersAdmin from './admin/UsersAdmin.vue';
import AuditAdmin from './admin/AuditAdmin.vue';
const session = useSession(),
  router = useRouter();
const active = ref('');
const can = (permission: string) => session.user?.permissions.includes(permission) ?? false;
const tabs = computed(() =>
  [
    { id: 'resources', label: '教室与座位', show: can('d.rooms.write'), component: ResourcesAdmin },
    {
      id: 'departments',
      label: '院系',
      show: can('d.departments.write'),
      component: DepartmentsAdmin,
    },
    {
      id: 'roles',
      label: '角色权限',
      show: can('d.roles.read') || can('d.roles.write'),
      component: RolesAdmin,
    },
    {
      id: 'users',
      label: '用户授权',
      show: can('d.users.read') || can('d.users.write'),
      component: UsersAdmin,
    },
    { id: 'audit', label: '操作审计', show: can('d.audit.read'), component: AuditAdmin },
  ].filter((item) => item.show),
);
const selected = computed(() => tabs.value.find((item) => item.id === active.value));
watch(
  tabs,
  (items) => {
    if (!items.some((item) => item.id === active.value)) active.value = items[0]?.id ?? '';
  },
  { immediate: true },
);
watch(
  () => session.loggedIn,
  (value) => {
    if (!value) {
      active.value = '';
      void router.replace('/login');
    }
  },
);
onMounted(() => {
  if (!session.loggedIn) void router.replace('/login');
});
</script>
<template>
  <header class="page-header">
    <p class="eyebrow">CAMPUS ADMINISTRATION</p>
    <h1>公共管理</h1>
    <p>登记资源、维护权限与开放时间，并查看操作记录。每项操作都按账号的实际管理范围检查。</p>
  </header>
  <div v-if="tabs.length" class="admin-tabs" role="tablist" aria-label="管理功能">
    <button
      v-for="item in tabs"
      :key="item.id"
      class="secondary-button"
      :class="{ active: active === item.id }"
      role="tab"
      :aria-selected="active === item.id"
      @click="active = item.id"
    >
      {{ item.label }}
    </button>
  </div>
  <p v-else class="notice">当前账号没有公共管理权限。教室目录和个人业务仍可从侧栏访问。</p>
  <component :is="selected.component" v-if="selected" :key="selected.id" />
</template>

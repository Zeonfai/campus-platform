import { createRouter, createWebHistory } from 'vue-router';
const WorkspaceOverview = () => import('./views/WorkspaceOverview.vue');
const ModuleOverview = () => import('./views/ModuleOverview.vue');

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: WorkspaceOverview },
    { path: '/bookings', component: () => import('./modules/m1/BookingPage.vue') },
    { path: '/work-orders', component: () => import('./modules/m3/WorkOrderPage.vue') },
    { path: '/applications', component: () => import('./modules/m2/ApplicationPage.vue') },
    { path: '/login', component: () => import('./modules/d/LoginPage.vue') },
    { path: '/directory', component: () => import('./modules/d/DirectoryPage.vue') },
    { path: '/modules/:module', component: ModuleOverview },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

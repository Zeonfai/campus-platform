import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const core = env.CORE_PROXY_TARGET ?? 'http://127.0.0.1:3001';
  const workflow = env.WORKFLOW_PROXY_TARGET ?? 'http://127.0.0.1:3002';
  return {
    plugins: [vue()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api/v1/applications': { target: workflow },
        '/api/v1/maintenance-policies': { target: workflow },
        '/api/v1/approval-policies': { target: workflow },
        '/api/v1/work-orders': { target: workflow },
        '/api': { target: core },
        '/core-health': {
          target: core,
          rewrite: (path) => path.replace(/^\/core-health/, '/health'),
        },
        '/workflow-health': {
          target: workflow,
          rewrite: (path) => path.replace(/^\/workflow-health/, '/health'),
        },
      },
    },
  };
});

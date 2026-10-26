import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { components } from '@campus/contracts/api';

export class PublicApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly traceId?: string,
  ) {
    super(message);
  }
}
export const useSession = defineStore('session', () => {
  // Deliberately not persisted in localStorage, sessionStorage, cookies or URLs.
  const token = ref<string>();
  const user = ref<components['schemas']['User']>();
  const expiresAt = ref<string>();
  const loggedIn = computed(() => Boolean(token.value && user.value));
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clear(): void {
    token.value = undefined;
    user.value = undefined;
    expiresAt.value = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith('/api/v1/')) throw new Error('Only public API paths are allowed');
    if (expiresAt.value && Date.parse(expiresAt.value) <= Date.now()) clear();
    const sentToken = token.value;
    const headers = new Headers(init.headers);
    if (token.value) headers.set('authorization', `Bearer ${token.value}`);
    const response = await fetch(path, {
      ...init,
      headers,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      if (response.status === 401 && token.value === sentToken) clear();
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; traceId?: string };
      };
      const messages: Record<number, string> = {
        400: '请检查输入内容',
        401: '登录信息无效或会话已过期',
        403: '当前账号没有此项权限',
        404: '资源不存在或不在你的可见范围',
        422: '当前状态或时间不允许此操作，请刷新记录并检查签到窗口',
        429: '尝试过于频繁，请稍后再试',
        501: '此功能还在开发中',
        503: '服务暂时不可用',
      };
      throw new PublicApiError(
        response.status,
        messages[response.status] ?? '请求失败，请稍后重试',
        body.error?.traceId,
      );
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }
  async function login(username: string, password: string): Promise<void> {
    const result = await request<components['schemas']['Session']>('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    clear();
    token.value = result.accessToken;
    user.value = result.user;
    expiresAt.value = result.expiresAt;
    timer = setTimeout(clear, Math.max(0, Date.parse(result.expiresAt) - Date.now()));
  }
  async function logout(): Promise<void> {
    // On transport failure keep the session so the user can retry revocation.
    await request<void>('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    clear();
  }
  return { user, expiresAt, loggedIn, login, logout, request, clear };
});

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { components } from '@campus/contracts/api';
import { PublicApiError, useSession } from '../session';

export type Department = components['schemas']['Department'];
export type Role = components['schemas']['Role'];
export type Room = components['schemas']['Room'];
export type Seat = components['schemas']['Seat'];
export type ManagedUser = components['schemas']['User'];
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export type OpeningSchedule = components['schemas']['OpeningSchedule'];
export const scopes = [
  { value: 'SELF', label: '仅本人' },
  { value: 'DEPARTMENT', label: '同院系' },
  { value: 'MANAGED_ROOMS', label: '指定教室' },
  { value: 'ALL', label: '全部范围' },
] as const;
export const scopeLabel = (value: string) =>
  scopes.find((item) => item.value === value)?.label ?? value;
class StaleAdminRequest extends Error {}
export function mergeItems<T extends { id: string }>(old: T[], added: T[]): T[] {
  return [...new Map([...old, ...added].map((item) => [item.id, item])).values()];
}
export function useDraftRevision() {
  const revision = ref<number>();
  const stale = ref(false);
  const ready = computed(() => revision.value !== undefined && !stale.value);
  function begin(value: number | undefined): boolean {
    if (!Number.isInteger(value) || !value || value < 1) return false;
    revision.value = value;
    stale.value = false;
    return true;
  }
  function reset() {
    revision.value = undefined;
    stale.value = false;
  }
  return {
    revision,
    stale,
    ready,
    begin,
    reset,
    invalidate: () => {
      stale.value = true;
    },
  };
}
export function useAdminApi() {
  const session = useSession(),
    router = useRouter();
  const busy = ref(false),
    error = ref(''),
    notice = ref('');
  const keys = new Map<string, string>();
  const cleaners: (() => void)[] = [];
  let generation = 0;
  const can = (permission: string) => session.user?.permissions.includes(permission) ?? false;
  async function read<T>(path: string): Promise<T> {
    const version = generation;
    const result = await session.request<T>(path);
    if (version !== generation) throw new StaleAdminRequest();
    return result;
  }
  async function run(action: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    notice.value = '';
    const version = generation;
    try {
      await action();
    } catch (failure) {
      if (version !== generation || failure instanceof StaleAdminRequest) return;
      error.value =
        failure instanceof PublicApiError
          ? failure.status === 409
            ? '数据已变化或记录存在冲突。输入已保留；编辑草稿已失效，请从列表重新选择记录或重新读取开放规则。新建记录请检查编号或名称是否重复。'
            : failure.status === 403
              ? '当前账号没有此项管理权限或不在允许的管理范围。'
              : failure.message
          : '请求结果尚未确认，请刷新或用相同内容重试。';
    } finally {
      busy.value = false;
    }
  }
  async function mutate<T>(
    path: string,
    method: 'POST' | 'PATCH' | 'PUT',
    payload: unknown,
    after: (result: T) => Promise<void>,
    conflict?: () => Promise<void>,
  ) {
    await run(async () => {
      const fingerprint = JSON.stringify([path, method, payload]);
      const key = keys.get(fingerprint) ?? crypto.randomUUID();
      keys.set(fingerprint, key);
      let result: T;
      try {
        const version = generation;
        result = await session.request<T>(path, {
          method,
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify(payload),
        });
        if (version !== generation) throw new StaleAdminRequest();
      } catch (failure) {
        if (failure instanceof PublicApiError && failure.status === 409 && conflict)
          await conflict();
        throw failure;
      }
      keys.delete(fingerprint);
      notice.value = '已保存。列表会重新读取当前状态。';
      await after(result);
    });
  }
  async function all<T>(path: string): Promise<T[]> {
    const result: T[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const page = await read<Page<T>>(path + (path.includes('?') ? '&' : '?') + query);
      result.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Repeated directory cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return result;
  }
  function revision(value: number | undefined): number {
    if (!Number.isInteger(value) || !value || value < 1)
      throw new Error('Missing current revision');
    return value;
  }
  function clear() {
    generation++;
    keys.clear();
    error.value = '';
    notice.value = '';
    for (const clean of cleaners) clean();
  }
  watch(
    () => session.loggedIn,
    (loggedIn) => {
      if (!loggedIn) {
        clear();
        void router.replace('/login');
      }
    },
  );
  onMounted(() => {
    if (!session.loggedIn) void router.replace('/login');
  });
  onUnmounted(clear);
  return {
    session,
    busy,
    error,
    notice,
    can,
    read,
    run,
    mutate,
    all,
    revision,
    onClear: (clean: () => void) => cleaners.push(clean),
  };
}

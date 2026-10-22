import type { components } from './generated/api.js';
import type {
  MaintenanceCommand,
  OccupancyCommand,
  ResourceCommand,
  ResourceEffect,
} from './protocol.ts';

export class ResourceApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly traceId: string | undefined;
  constructor(
    code: string,
    message: string,
    retryable: boolean,
    status?: number,
    traceId?: string,
  ) {
    super(message);
    this.name = 'ResourceApiError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.traceId = traceId;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEffect(value: unknown): value is ResourceEffect {
  return (
    record(value) &&
    ['M2', 'M3'].includes(String(value.sourceModule)) &&
    typeof value.sourceId === 'string' &&
    typeof value.operationId === 'string' &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    ['ACTIVE', 'RELEASED'].includes(String(value.state)) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

/** 仅发送一次命令。调用方须先持久化 outbox，并用同一 operationId/revision 重试。 */
async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65536) {
        await reader.cancel();
        throw new ResourceApiError(
          'INVALID_UPSTREAM_RESPONSE',
          'Resource response is too large',
          true,
        );
      }
      chunks.push(next.value);
    }
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new ResourceApiError(
      'INVALID_UPSTREAM_RESPONSE',
      'Resource response is not JSON',
      true,
      response.status,
    );
  }
  return result;
}

type UserContext = components['schemas']['PrivateUserContext'];
function isUserContext(value: unknown): value is UserContext {
  const strings = (item: unknown) =>
    Array.isArray(item) &&
    item.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 200);
  return (
    record(value) &&
    record(value.user) &&
    typeof value.user.id === 'string' &&
    typeof value.user.displayName === 'string' &&
    value.user.enabled === true &&
    strings(value.user.permissions) &&
    (value.user.departmentId === undefined || typeof value.user.departmentId === 'string') &&
    strings(value.roleIds) &&
    strings(value.managedRoomIds) &&
    Array.isArray(value.grants) &&
    value.grants.every(
      (grant: unknown) =>
        record(grant) &&
        typeof grant.permission === 'string' &&
        ['SELF', 'DEPARTMENT', 'MANAGED_ROOMS', 'ALL'].includes(String(grant.scope)),
    )
  );
}

export class ResourceCoreClient {
  private readonly base: URL;
  private readonly options: { baseUrl: string; serviceToken: () => string; timeoutMs?: number };

  constructor(options: { baseUrl: string; serviceToken: () => string; timeoutMs?: number }) {
    this.options = options;
    this.base = new URL(options.baseUrl);
    if (
      !['http:', 'https:'].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== '/'
    ) {
      throw new Error('Resource baseUrl must be an HTTP(S) origin without credentials');
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    ) {
      throw new Error('timeoutMs must be a positive integer');
    }
  }

  occupy(applicationId: string, command: OccupancyCommand): Promise<ResourceEffect> {
    return this.request('PUT', 'room-occupancies', applicationId, command);
  }

  releaseOccupancy(applicationId: string, command: ResourceCommand): Promise<ResourceEffect> {
    return this.request('POST', 'room-occupancies', applicationId, command, '/release');
  }

  block(workOrderId: string, command: MaintenanceCommand): Promise<ResourceEffect> {
    return this.request('PUT', 'maintenance-blocks', workOrderId, command);
  }

  releaseBlock(workOrderId: string, command: ResourceCommand): Promise<ResourceEffect> {
    return this.request('POST', 'maintenance-blocks', workOrderId, command, '/release');
  }

  async getUserContext(userAuthorization: string): Promise<UserContext> {
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(userAuthorization))
      throw new Error('A user bearer is required');
    const token = this.options.serviceToken();
    if (!token || /[\r\n]/.test(token)) throw new Error('A valid service token is required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await fetch(new URL('/internal/v1/identity/context', this.base), {
        redirect: 'error',
        signal: controller.signal,
        cache: 'no-store',
        headers: { authorization: `Bearer ${token}`, 'x-user-authorization': userAuthorization },
      });
      const result = await readJson(response);
      if (!response.ok)
        throw new ResourceApiError(
          'IDENTITY_CHECK_FAILED',
          'User context could not be verified',
          response.status >= 500 || response.status === 429,
          response.status,
        );
      if (!isUserContext(result))
        throw new ResourceApiError(
          'INVALID_UPSTREAM_RESPONSE',
          'Invalid user context',
          true,
          response.status,
        );
      return result;
    } catch (error) {
      if (error instanceof ResourceApiError) throw error;
      throw new ResourceApiError('IDENTITY_QUERY_UNAVAILABLE', 'User context is unavailable', true);
    } finally {
      clearTimeout(timer);
    }
  }

  async getRoomContext(
    roomId: string,
    userAuthorization: string,
  ): Promise<components['schemas']['Room']> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(roomId) || roomId.includes('..'))
      throw new Error('Invalid room ID');
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(userAuthorization))
      throw new Error('A user bearer is required');
    const token = this.options.serviceToken();
    if (!token || /[\r\n]/.test(token)) throw new Error('A valid service token is required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await fetch(
        new URL(`/internal/v1/identity/rooms/${encodeURIComponent(roomId)}`, this.base),
        {
          redirect: 'error',
          signal: controller.signal,
          cache: 'no-store',
          headers: { authorization: `Bearer ${token}`, 'x-user-authorization': userAuthorization },
        },
      );
      const result = await readJson(response);
      if (!response.ok)
        throw new ResourceApiError(
          'ROOM_CHECK_FAILED',
          'Room could not be verified',
          response.status >= 500 || response.status === 429,
          response.status,
        );
      if (
        !record(result) ||
        result.id !== roomId ||
        typeof result.code !== 'string' ||
        typeof result.name !== 'string' ||
        result.enabled !== true ||
        typeof result.restrictedToDepartment !== 'boolean' ||
        (result.departmentId !== undefined && typeof result.departmentId !== 'string')
      )
        throw new ResourceApiError(
          'INVALID_UPSTREAM_RESPONSE',
          'Invalid room context',
          true,
          response.status,
        );
      return result as unknown as components['schemas']['Room'];
    } catch (error) {
      if (error instanceof ResourceApiError) throw error;
      throw new ResourceApiError('ROOM_QUERY_UNAVAILABLE', 'Room context is unavailable', true);
    } finally {
      clearTimeout(timer);
    }
  }

  private async delegatedContext(path: string, userAuthorization: string): Promise<unknown> {
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(userAuthorization))
      throw new Error('A user bearer is required');
    const token = this.options.serviceToken();
    if (!token || /[\r\n]/.test(token)) throw new Error('A valid service token is required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await fetch(new URL(path, this.base), {
        redirect: 'error',
        signal: controller.signal,
        cache: 'no-store',
        headers: { authorization: `Bearer ${token}`, 'x-user-authorization': userAuthorization },
      });
      const result = await readJson(response);
      if (!response.ok)
        throw new ResourceApiError(
          'WORK_ORDER_CONTEXT_FAILED',
          'Work-order context could not be verified',
          response.status >= 500 || response.status === 429,
          response.status,
        );
      return result;
    } catch (error) {
      if (error instanceof ResourceApiError) throw error;
      throw new ResourceApiError(
        'CONTEXT_QUERY_UNAVAILABLE',
        'Work-order context is unavailable',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async getWorkOrderRoomContext(
    roomId: string,
    userAuthorization: string,
  ): Promise<components['schemas']['WorkOrderRoomContext']> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(roomId) || roomId.includes('..'))
      throw new Error('Invalid room ID');
    const context = await this.delegatedContext(
      `/internal/v1/identity/work-order-rooms/${encodeURIComponent(roomId)}`,
      userAuthorization,
    );
    const result = record(context) ? context.room : undefined;
    if (
      !record(context) ||
      !Array.isArray(context.escalationRecipientIds) ||
      context.escalationRecipientIds.length > 500 ||
      !context.escalationRecipientIds.every(
        (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 100,
      ) ||
      !record(result) ||
      result.id !== roomId ||
      typeof result.code !== 'string' ||
      typeof result.name !== 'string' ||
      result.enabled !== true ||
      typeof result.restrictedToDepartment !== 'boolean' ||
      (result.departmentId !== undefined && typeof result.departmentId !== 'string')
    )
      throw new ResourceApiError(
        'INVALID_UPSTREAM_RESPONSE',
        'Invalid work-order room context',
        true,
      );
    return context as unknown as components['schemas']['WorkOrderRoomContext'];
  }

  async getRepairerContext(
    roomId: string,
    userId: string,
    userAuthorization: string,
  ): Promise<{ userId: string; displayName: string }> {
    for (const id of [roomId, userId])
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || id.includes('..'))
        throw new Error('Invalid repairer context ID');
    const result = await this.delegatedContext(
      `/internal/v1/identity/work-order-rooms/${encodeURIComponent(roomId)}/repairers/${encodeURIComponent(userId)}`,
      userAuthorization,
    );
    if (!record(result) || result.userId !== userId || typeof result.displayName !== 'string')
      throw new ResourceApiError('INVALID_UPSTREAM_RESPONSE', 'Invalid repairer context', true);
    return { userId, displayName: result.displayName };
  }

  async getOccupancy(sourceId: string): Promise<ResourceEffect> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sourceId) || sourceId.includes('..'))
      throw new Error('Invalid source ID');
    const token = this.options.serviceToken();
    if (!token || /[\r\n]/.test(token)) throw new Error('A valid service token is required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await fetch(
        new URL(`/internal/v1/room-occupancies/${encodeURIComponent(sourceId)}`, this.base),
        {
          redirect: 'error',
          signal: controller.signal,
          cache: 'no-store',
          headers: { authorization: `Bearer ${token}` },
        },
      );
      const result = await readJson(response);
      if (!response.ok) {
        const error = record(result) && record(result.error) ? result.error : {};
        throw new ResourceApiError(
          typeof error.code === 'string' ? error.code : 'UPSTREAM_HTTP_ERROR',
          'Source query failed',
          response.status >= 500 || response.status === 429,
          response.status,
        );
      }
      if (!isEffect(result) || result.sourceId !== sourceId || result.sourceModule !== 'M2')
        throw new ResourceApiError(
          'INVALID_UPSTREAM_RESPONSE',
          'Source query result does not match',
          true,
          response.status,
        );
      return result;
    } catch (error) {
      if (error instanceof ResourceApiError) throw error;
      throw new ResourceApiError(
        'RESOURCE_QUERY_UNAVAILABLE',
        'Source query was not confirmed',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async getBlock(sourceId: string): Promise<ResourceEffect> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sourceId) || sourceId.includes('..'))
      throw new Error('Invalid source ID');
    const token = this.options.serviceToken();
    if (!token || /[\r\n]/.test(token)) throw new Error('A valid service token is required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await fetch(
        new URL(`/internal/v1/maintenance-blocks/${encodeURIComponent(sourceId)}`, this.base),
        {
          redirect: 'error',
          signal: controller.signal,
          cache: 'no-store',
          headers: { authorization: `Bearer ${token}` },
        },
      );
      const result = await readJson(response);
      if (!response.ok) {
        const error = record(result) && record(result.error) ? result.error : {};
        throw new ResourceApiError(
          typeof error.code === 'string' ? error.code : 'UPSTREAM_HTTP_ERROR',
          'Source query failed',
          response.status >= 500 || response.status === 429,
          response.status,
        );
      }
      if (!isEffect(result) || result.sourceId !== sourceId || result.sourceModule !== 'M3')
        throw new ResourceApiError(
          'INVALID_UPSTREAM_RESPONSE',
          'Source query result does not match',
          true,
          response.status,
        );
      return result;
    } catch (error) {
      if (error instanceof ResourceApiError) throw error;
      throw new ResourceApiError(
        'RESOURCE_QUERY_UNAVAILABLE',
        'Source query was not confirmed',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    method: 'PUT' | 'POST',
    collection: string,
    sourceId: string,
    command: ResourceCommand,
    suffix = '',
  ): Promise<ResourceEffect> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sourceId) ||
      sourceId.includes('..') ||
      !command.actorId ||
      !command.reason.trim() ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        command.operationId,
      ) ||
      !Number.isSafeInteger(command.revision) ||
      command.revision < 1 ||
      command.revision > 2147483647
    ) {
      throw new Error('Invalid resource command identity, actor, reason or revision');
    }
    const token = this.options.serviceToken();
    if (!token || /[\r\n]/.test(token)) throw new Error('A valid service token is required');
    const url = new URL(
      `/internal/v1/${collection}/${encodeURIComponent(sourceId)}${suffix}`,
      this.base,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await fetch(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': command.operationId,
        },
        body: JSON.stringify(command),
      });
      // 小型命令响应有明确上限；不将上游完整错误内容带入日志或重试记录。
      const result = await readJson(response);
      if (!response.ok) {
        const error: Record<string, unknown> =
          record(result) && record(result.error) ? result.error : {};
        throw new ResourceApiError(
          typeof error.code === 'string' ? error.code : 'UPSTREAM_HTTP_ERROR',
          'Resource command was not confirmed',
          response.status >= 500 || response.status === 429,
          response.status,
          typeof error.traceId === 'string' ? error.traceId : undefined,
        );
      }
      if (
        !isEffect(result) ||
        result.sourceId !== sourceId ||
        result.operationId !== command.operationId ||
        result.revision !== command.revision ||
        result.sourceModule !== (collection === 'room-occupancies' ? 'M2' : 'M3') ||
        result.state !== (suffix ? 'RELEASED' : 'ACTIVE')
      ) {
        throw new ResourceApiError(
          'INVALID_UPSTREAM_RESPONSE',
          'Resource result does not match command',
          true,
          response.status,
        );
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof ResourceApiError) throw error;
      throw new ResourceApiError(
        controller.signal.aborted ? 'RESOURCE_SYNC_TIMEOUT' : 'RESOURCE_SYNC_UNAVAILABLE',
        'Resource outcome is unknown; reconcile or retry the persisted command',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

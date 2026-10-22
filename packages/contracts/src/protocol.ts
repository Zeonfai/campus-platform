export interface ApiErrorBody {
  error: { code: string; message: string; traceId: string };
}

export interface ResourceCommand {
  operationId: string;
  revision: number;
  actorId: string;
  reason: string;
}

export interface OccupancyCommand extends ResourceCommand {
  roomId: string;
  startsAt: string;
  endsAt: string;
}

export interface MaintenanceCommand extends ResourceCommand {
  roomId: string;
  startsAt: string;
}

export interface ResourceEffect {
  sourceModule: 'M2' | 'M3';
  sourceId: string;
  operationId: string;
  revision: number;
  state: 'ACTIVE' | 'RELEASED';
  updatedAt: string;
}

export type ServiceName = 'resource-core' | 'workflow';
export interface ServiceHealth {
  service: ServiceName;
  status: 'live' | 'ready';
  timestamp: string;
}

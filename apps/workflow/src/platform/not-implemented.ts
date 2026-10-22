import { HttpException, HttpStatus } from '@nestjs/common';

export function notImplemented(operationId: string): never {
  throw new HttpException(
    {
      code: 'NOT_IMPLEMENTED',
      message: `${operationId} is a contract scaffold; business behavior is not implemented`,
    },
    HttpStatus.NOT_IMPLEMENTED,
  );
}

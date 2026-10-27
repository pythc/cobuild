import { Injectable } from '@nestjs/common';
import type { DependencyName } from '@shared/operations-insights.interface';
/** Monitoring retired. Compatibility adapter runs business work exactly once,
 * without timers, database writes, samples, spans or monitoring logs. */
@Injectable()
export class OperationsTelemetryService {
  async measure<T>(
    _dependency: DependencyName,
    _operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return action();
  }
  async operation<T>(
    _operationId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return action();
  }
  async scanner<T>(_name: string, action: () => Promise<T>): Promise<T> {
    return action();
  }
}

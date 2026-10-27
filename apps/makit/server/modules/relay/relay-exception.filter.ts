import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { FeishuRequestError } from '../requirements/feishu.service';
@Catch()
export class RelayExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(RelayExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    if (!(error instanceof HttpException) && !(error instanceof ZodError)) {
      this.logger.error(
        'Relay request failed: ' +
          (error instanceof Error ? error.name : 'UnknownError'),
      );
    }
    const res = host.switchToHttp().getResponse();
    if (res.headersSent) return;
    const status =
      error instanceof ZodError
        ? 400
        : error instanceof HttpException
          ? error.getStatus()
          : 503;
    const message =
      error instanceof FeishuRequestError
        ? '飞书暂时无法完成操作，请重试；若状态为核对中，请先核实结果'
        : error instanceof ZodError
          ? '内容格式无效，请核对后重试'
          : error instanceof HttpException
            ? error.message
            : '服务暂时不可用，请重试';
    res.setHeader('Cache-Control', 'no-store, private');
    res.status(status).json({ message });
  }
}

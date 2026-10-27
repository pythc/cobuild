import { Injectable, NestMiddleware } from '@nestjs/common';
/** All enrolment/identity comes from Feishu. There is no public local account path. */
@Injectable()
export class NativeAuthMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    let path: string;
    try {
      path = decodeURIComponent(
        new URL(req.originalUrl || req.url, 'http://local.invalid').pathname,
      )
        .replace(/^\/api\//, '/')
        .toLowerCase();
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (
      /^\/(auth\/(login|setup|change-password|forgot-password|password-reset|verify-token)|workspace(?:s)?\/invites?|invites?|sso|mfa|oauth|api-keys?|licen[cs]e|billing|ai|attachments\/(avatar|remove-avatar))(\/|$)/.test(
        path,
      )
    ) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: 'Not found', statusCode: 404 }));
      return;
    }
    next();
  }
}

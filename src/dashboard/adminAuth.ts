import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

const ADMIN_PASSWORD = config.dashboard.adminPassword;

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)admin_session=([^;]*)/);
  const sessionValue = match ? decodeURIComponent(match[1]) : '';

  if (sessionValue && sessionValue === ADMIN_PASSWORD) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
}

export function adminLoginRoute(req: Request, res: Response): void {
  const { password } = req.body || {};

  if (!password || password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  res.setHeader(
    'Set-Cookie',
    `admin_session=${encodeURIComponent(password)}; Max-Age=${maxAge / 1000}; HttpOnly; Path=/; SameSite=Lax`
  );
  res.status(200).json({ ok: true });
}

import { Request, Response, NextFunction } from 'express';

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)dashboard_session=([^;]*)/);
  const sessionValue = match ? decodeURIComponent(match[1]) : '';

  if (sessionValue && sessionValue === DASHBOARD_PASSWORD) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
}

export function loginRoute(req: Request, res: Response): void {
  const { password } = req.body || {};

  if (!password || password !== DASHBOARD_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  res.setHeader(
    'Set-Cookie',
    `dashboard_session=${encodeURIComponent(password)}; Max-Age=${maxAge / 1000}; HttpOnly; Path=/; SameSite=Lax`
  );
  res.status(200).json({ ok: true });
}

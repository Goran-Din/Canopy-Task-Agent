import express from 'express';
import path from 'path';
import { config } from './config';
import { setConfigValue } from './db/queries';
import { initDatabase } from './db/init';
import { bot } from './telegram/bot';
import { registerHandlers } from './telegram/handlers';
import { startLandscapeSync } from './workers/landscapeSync';
import { startInvoiceSync } from './workers/invoiceSync';
import { startUninvoicedAlert } from './workers/uninvoicedAlert';
import { startHardscapeSync } from './workers/hardscapeSync';
import { startNextcloudSync } from './workers/nextcloudSync';
import { startAfternoonBriefing } from './workers/afternoonBriefing';
import { authMiddleware, loginRoute } from './dashboard/auth';
import invoiceRoutes from './dashboard/invoiceRoutes';
import commentRoutes from './dashboard/commentRoutes';
import landscapeRoutes from './dashboard/landscapeRoutes';
import dashboardRouter from './api/dashboardRouter';
import knowledgeRouter from './api/knowledgeRouter';
import { adminLoginRoute } from './dashboard/adminAuth';

async function main(): Promise<void> {
  console.log(`Starting Canopy Task Agent — ${config.environment}`);

  await initDatabase();
  console.log('Database ready');

  registerHandlers();
  console.log('Telegram handlers registered');

  startLandscapeSync();    // every 15 min — SM8 crew sync + 6:30 AM morning alert
  startInvoiceSync();      // every 15 min — Xero invoice cache
  startUninvoicedAlert();  // 6:30 AM CT — uninvoiced job alert
  startHardscapeSync();    // hourly — SM8 hardscape quote detect, activity sync, completion check
  startNextcloudSync();      // hourly — Xero→Nextcloud folder sync
  startAfternoonBriefing(); // 6:00 PM CT — weather + crew briefing to group chat
  console.log('All workers started');

  const app = express();
  app.use(express.json());

  app.post('/webhook/telegram', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agent: 'Canopy Task Agent', timestamp: new Date().toISOString() });
  });

  // ── Xero OAuth re-auth routes (temporary) ─────────────────────
  app.get('/xero-reauth', (_req, res) => {
    const scopes = 'openid profile email accounting.contacts accounting.invoices offline_access';
    const authUrl = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${config.xero.clientId}&redirect_uri=${encodeURIComponent(config.xero.redirectUri)}&scope=${encodeURIComponent(scopes)}&state=reauth&prompt=consent`;
    res.redirect(authUrl);
  });

  app.get('/xero-callback', async (req, res) => {
    const code = req.query.code as string;
    if (!code) { res.status(400).send('Missing code parameter'); return; }
    try {
      const axios = require('axios');
      const credentials = Buffer.from(`${config.xero.clientId}:${config.xero.clientSecret}`).toString('base64');
      const tokenRes = await axios.post(
        'https://identity.xero.com/connect/token',
        new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.xero.redirectUri }).toString(),
        { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const { access_token, refresh_token, expires_in } = tokenRes.data;
      const expiryDate = new Date(Date.now() + expires_in * 1000);
      await setConfigValue('xero_access_token', access_token, expiryDate);
      await setConfigValue('xero_refresh_token', refresh_token);

      // Fetch and store tenant ID
      const conRes = await axios.get('https://api.xero.com/connections', {
        headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      });
      if (conRes.data?.[0]?.tenantId) {
        await setConfigValue('xero_tenant_id', conRes.data[0].tenantId);
      }
      res.send('Xero re-auth successful. Tokens saved. You can close this tab.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).send('Xero token exchange failed: ' + msg);
    }
  });

  // Serve React dashboards (no auth on static — the React apps handle login via API)
  const distDir = path.join(__dirname, '../dashboard/dist');
  app.use('/assets', express.static(path.join(distDir, 'assets')));

  // Hardscape dashboard — serves hardscape.html specifically
  app.use('/hardscape/assets', express.static(path.join(distDir, 'assets')));
  app.get('/hardscape', (_req, res) => {
    res.sendFile(path.join(distDir, 'hardscape.html'));
  });
  app.get('/hardscape/', (_req, res) => {
    res.sendFile(path.join(distDir, 'hardscape.html'));
  });
  app.get('/hardscape/*', (_req, res) => {
    res.sendFile(path.join(distDir, 'hardscape.html'));
  });

  // Admin dashboard — serves admin.html
  app.use('/admin/assets', express.static(path.join(distDir, 'assets')));
  app.post('/admin/login', adminLoginRoute);
  app.use('/', knowledgeRouter);
  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(distDir, 'admin.html'));
  });
  app.get('/admin/', (_req, res) => {
    res.sendFile(path.join(distDir, 'admin.html'));
  });
  app.get('/admin/*', (_req, res) => {
    res.sendFile(path.join(distDir, 'admin.html'));
  });

  // Landscape dashboard — serves index.html
  app.use('/crews', express.static(distDir));
  app.get('/crews/*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  // Dashboard API routes
  app.post('/dashboard/login', loginRoute);
  app.use('/api', authMiddleware, invoiceRoutes);
  app.use('/api', authMiddleware, commentRoutes);
  app.use('/', authMiddleware, landscapeRoutes);
  app.use('/', authMiddleware, dashboardRouter);

  app.listen(config.port, () => {
    console.log(`Canopy Task Agent listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

import { pool } from './db/pool';
import logger from './logger';
import { notifyUser } from './tools/telegram_notify';

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  await new Promise(resolve => setTimeout(resolve, 5000));
  await pool.end();
  logger.info('Database pool closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down');
  await pool.end();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ event: 'unhandled_rejection', reason: String(reason) });
  notifyUser({ recipient: 'goran', message: 'Agent unhandled error: ' + String(reason) }).catch(() => {});
});

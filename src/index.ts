import express from 'express';
import { config } from './config';
import { initDatabase } from './db/init';
import { bot } from './telegram/bot';
import { registerHandlers } from './telegram/handlers';
import { startLandscapeSync } from './workers/landscapeSync';
import { startInvoiceSync } from './workers/invoiceSync';
import { startUninvoicedAlert } from './workers/uninvoicedAlert';
import { authMiddleware, loginRoute } from './dashboard/auth';
import invoiceRoutes from './dashboard/invoiceRoutes';
import commentRoutes from './dashboard/commentRoutes';

async function main(): Promise<void> {
  console.log(`Starting Canopy Task Agent — ${config.environment}`);

  await initDatabase();
  console.log('Database ready');

  registerHandlers();
  console.log('Telegram handlers registered');

  startLandscapeSync();    // every 15 min — SM8 crew sync + 6:30 AM morning alert
  startInvoiceSync();      // every 15 min — Xero invoice cache
  startUninvoicedAlert();  // 6:30 AM CT — uninvoiced job alert
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

  // Dashboard routes
  app.post('/dashboard/login', loginRoute);
  app.use('/api', authMiddleware, invoiceRoutes);
  app.use('/api', authMiddleware, commentRoutes);

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

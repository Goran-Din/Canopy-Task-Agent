import express from 'express';
import { config } from './config';
import { initDatabase } from './db/init';
import { bot } from './telegram/bot';
import { registerHandlers } from './telegram/handlers';

async function main(): Promise<void> {
  console.log(`Starting Canopy Task Agent — ${config.environment}`);

  await initDatabase();
  console.log('Database ready');

  registerHandlers();
  console.log('Telegram handlers registered');

  const app = express();
  app.use(express.json());

  app.post('/webhook/telegram', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agent: 'Canopy Task Agent', timestamp: new Date().toISOString() });
  });

  app.listen(config.port, () => {
    console.log(`Canopy Task Agent listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

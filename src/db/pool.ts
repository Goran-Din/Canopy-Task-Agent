import { Pool } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  connectionString: config.database.url,
  min: config.database.poolMin,
  max: config.database.poolMax,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

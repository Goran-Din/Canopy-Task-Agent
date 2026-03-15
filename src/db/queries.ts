import { pool } from './pool';
import { User, ConversationTurn } from '../types';

export async function getUserByTelegramId(telegramId: number): Promise<User | null> {
  const result = await pool.query(
    'SELECT * FROM users WHERE telegram_id = $1 AND active = TRUE',
    [telegramId]
  );
  return result.rows[0] || null;
}

export async function getConversationHistory(telegramId: number): Promise<ConversationTurn[]> {
  const result = await pool.query(
    `SELECT role, content FROM conversations
     WHERE telegram_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [telegramId]
  );
  return result.rows.reverse();
}

export async function saveConversationTurn(
  telegramId: number,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  await pool.query(
    'INSERT INTO conversations (telegram_id, role, content) VALUES ($1, $2, $3)',
    [telegramId, role, content]
  );
}

export async function saveTask(data: {
  vikunja_task_id: number;
  title: string;
  assigned_to: number;
  created_by: number;
  sm8_job_uuid?: string;
  sm8_client_name?: string;
  job_type?: string;
  vikunja_label_id?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO task_history
      (vikunja_task_id, title, assigned_to, created_by, sm8_job_uuid, sm8_client_name, job_type, vikunja_label_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      data.vikunja_task_id,
      data.title,
      data.assigned_to,
      data.created_by,
      data.sm8_job_uuid || null,
      data.sm8_client_name || null,
      data.job_type || null,
      data.vikunja_label_id || null,
    ]
  );
}

export async function updateTask(
  vikunjaTaskId: number,
  status: string,
  completedAt?: Date
): Promise<void> {
  await pool.query(
    `UPDATE task_history
     SET status = $1, completed_at = $2, updated_at = NOW()
     WHERE vikunja_task_id = $3`,
    [status, completedAt || null, vikunjaTaskId]
  );
}

export async function cacheClient(data: {
  client_name: string;
  sm8_uuid: string;
  last_job_uuid?: string;
  last_job_status?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO client_context (client_name, sm8_uuid, last_job_uuid, last_job_status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sm8_uuid) DO UPDATE
       SET client_name = $1,
           last_job_uuid = $3,
           last_job_status = $4,
           cached_at = NOW()`,
    [data.client_name, data.sm8_uuid, data.last_job_uuid || null, data.last_job_status || null]
  );
}

export async function getCachedClient(clientName: string): Promise<{ sm8_uuid: string; last_job_uuid: string | null } | null> {
  const result = await pool.query(
    `SELECT sm8_uuid, last_job_uuid FROM client_context
     WHERE LOWER(client_name) LIKE LOWER($1)
     ORDER BY cached_at DESC LIMIT 1`,
    [`%${clientName}%`]
  );
  return result.rows[0] || null;
}

export async function trimConversationHistory(telegramId: number): Promise<void> {
  await pool.query(
    `DELETE FROM conversations
     WHERE telegram_id = $1
     AND id NOT IN (
       SELECT id FROM conversations
       WHERE telegram_id = $1
       ORDER BY created_at DESC
       LIMIT 20
     )`,
    [telegramId]
  );
}

export async function getConfigValue(key: string): Promise<string | null> {
  const result = await pool.query(
    'SELECT value FROM config_store WHERE key = $1',
    [key]
  );
  return result.rows[0]?.value || null;
}

export async function setConfigValue(key: string, value: string, expiresAt?: Date): Promise<void> {
  await pool.query(
    `INSERT INTO config_store (key, value, expires_at, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = $2, expires_at = $3, updated_at = NOW()`,
    [key, value, expiresAt || null]
  );
}

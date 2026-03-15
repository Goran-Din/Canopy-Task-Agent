import TelegramBot from 'node-telegram-bot-api';
import { bot } from './bot';
import { getUserByTelegramId } from '../db/queries';
import { runAgent } from '../agent/core';
import { notifyUser } from '../tools/telegram_notify';
import logger from '../logger';
import { isRateLimited } from '../middleware/rateLimiter';
import { isDuplicate } from '../middleware/deduplication';

const GORAN_TELEGRAM_ID = 1996235953;

function isAdmin(telegramId: number): boolean {
  return telegramId === GORAN_TELEGRAM_ID;
}

async function handleAdminCommand(text: string, chatId: number): Promise<void> {
  const parts = text.trim().split(' ');
  const command = parts[0].toLowerCase();

  if (command === '/status') {
    const { pool } = await import('../db/pool');
    const users = await pool.query('SELECT COUNT(*) FROM users WHERE active = TRUE');
    const tasks = await pool.query('SELECT COUNT(*) FROM task_history');
    const convs = await pool.query('SELECT COUNT(*) FROM conversations');
    const msg = `Canopy Task Agent — Status\n\nUsers: ${users.rows[0].count} active\nTasks created: ${tasks.rows[0].count}\nConversation turns: ${convs.rows[0].count}\nContainer: running\nWebhook: https://tasks-agent.sunsetapp.us/webhook/telegram`;
    await bot.sendMessage(chatId, msg);
    return;
  }

  if (command === '/listusers') {
    const { pool } = await import('../db/pool');
    const result = await pool.query('SELECT name, role, active FROM users ORDER BY role');
    const list = result.rows.map((u: { name: string; role: string; active: boolean }) =>
      `${u.active ? '✅' : '❌'} ${u.name} — ${u.role}`
    ).join('\n');
    await bot.sendMessage(chatId, `Team Members:\n\n${list}`);
    return;
  }

  if (command === '/broadcast') {
    const message = parts.slice(1).join(' ');
    if (!message) {
      await bot.sendMessage(chatId, 'Usage: /broadcast Your message here');
      return;
    }
    const { pool } = await import('../db/pool');
    const result = await pool.query('SELECT telegram_id, name FROM users WHERE active = TRUE');
    let sent = 0;
    for (const user of result.rows) {
      try {
        await bot.sendMessage(user.telegram_id, `📢 Broadcast from Goran:\n\n${message}`);
        sent++;
      } catch {
        logger.warn({ event: 'broadcast_failed', user: user.name });
      }
    }
    await bot.sendMessage(chatId, `Broadcast sent to ${sent} team members.`);
    return;
  }

  await bot.sendMessage(chatId, 'Available commands: /status · /listusers · /broadcast [message]');
}

export function registerHandlers(): void {
  bot.on('message', async (msg: TelegramBot.Message) => {
    if (isDuplicate(msg.message_id)) return;

    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    const text = msg.text;

    if (!telegramId) return;

    if (!text) {
      await bot.sendMessage(chatId, 'Please send text messages. Voice and photos are not supported yet.');
      return;
    }

    if (isRateLimited(telegramId)) {
      return;
    }

    if (text.startsWith('/')) {
      if (!telegramId || !isAdmin(telegramId)) {
        await bot.sendMessage(chatId, 'Unknown command.');
        return;
      }
      await handleAdminCommand(text, chatId);
      return;
    }

    try {
      const user = await getUserByTelegramId(telegramId);

      if (!user) {
        await bot.sendMessage(
          chatId,
          'Hi! You are not registered in the Canopy Task Agent system. Please contact Goran to get access.'
        );
        return;
      }

      logger.info({ event: 'message_received', user: user.name, role: user.role, length: text.length });

      await bot.sendChatAction(chatId, 'typing');

      const reply = await runAgent(user, text);

      await bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });

      logger.info({ event: 'message_replied', user: user.name });

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ event: 'handler_error', error: error.message, stack: error.stack });

      await bot.sendMessage(
        chatId,
        'Something went wrong. Goran has been notified.'
      );

      try {
        await notifyUser({
          recipient: 'goran',
          message: `Agent error from ${telegramId}: ${error.message}`,
          notification_type: 'urgent',
        });
      } catch {
        logger.error({ event: 'notify_goran_failed', error: error.message });
      }
    }
  });
}

import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { bot } from './bot';
import { getUserByTelegramId, getConfigValue, setConfigValue } from '../db/queries';
import { runAgent, runAgentWithPhoto } from '../agent/core';
import { notifyUser } from '../tools/telegram_notify';
import { config } from '../config';
import logger from '../logger';
import { isRateLimited } from '../middleware/rateLimiter';
import { isDuplicate } from '../middleware/deduplication';

const pendingPhotos: Map<number, { fileId: string; caption?: string; timestamp: number }> = new Map();
const PHOTO_WAIT_MS = 8000;

async function downloadTelegramPhoto(fileId: string): Promise<string> {
  const token = config.telegram.botToken;
  const fileRes = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const filePath = fileRes.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const imgRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(imgRes.data).toString('base64');
}

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
  bot.on('photo', async (msg: TelegramBot.Message) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await bot.sendMessage(chatId, 'You are not registered. Please contact Goran to get access.');
      return;
    }

    // Get the highest resolution photo
    const photos = msg.photo || [];
    const bestPhoto = photos[photos.length - 1];
    const caption = msg.caption || undefined;

    // Store photo and wait for follow-up text
    pendingPhotos.set(telegramId, {
      fileId: bestPhoto.file_id,
      caption,
      timestamp: Date.now(),
    });

    await bot.sendChatAction(chatId, 'typing');

    // Wait 8 seconds for a follow-up text message
    setTimeout(async () => {
      const pending = pendingPhotos.get(telegramId);
      if (!pending) return; // already processed by text handler

      // No follow-up text came — process photo alone
      pendingPhotos.delete(telegramId);

      try {
        const base64Image = await downloadTelegramPhoto(pending.fileId);
        const textContext = pending.caption || 'No additional message provided.';
        const reply = await runAgentWithPhoto(user, base64Image, textContext);
        await bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ event: 'photo_handler_error', error: error.message });
        await bot.sendMessage(chatId, 'Could not process the photo. Please try again or type your request.');
      }
    }, PHOTO_WAIT_MS);
  });

  bot.on('message', async (msg: TelegramBot.Message) => {
    if (isDuplicate(msg.message_id)) return;

    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    const text = msg.text;

    if (!telegramId) return;

    // Ignore photo messages — handled by the photo handler above
    if (msg.photo) return;

    if (!text) {
      await bot.sendMessage(chatId, 'Please send text messages. Voice is not supported yet. Photos are supported!');
      return;
    }

    if (isRateLimited(telegramId)) {
      return;
    }

    // Check if there is a pending photo waiting for this text message
    const pending = pendingPhotos.get(telegramId);
    if (pending && Date.now() - pending.timestamp < PHOTO_WAIT_MS + 2000) {
      pendingPhotos.delete(telegramId);
      try {
        await bot.sendChatAction(chatId, 'typing');
        const base64Image = await downloadTelegramPhoto(pending.fileId);
        const user = await getUserByTelegramId(telegramId);
        if (user) {
          const reply = await runAgentWithPhoto(user, base64Image, text);
          await bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
          return;
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ event: 'photo_text_handler_error', error: error.message });
      }
    }

    if (text.startsWith('/')) {
      if (!telegramId || !isAdmin(telegramId)) {
        await bot.sendMessage(chatId, 'Unknown command.');
        return;
      }
      await handleAdminCommand(text, chatId);
      return;
    }

    // Handle "skip <uuid>" replies for hardscape quote detection
    const skipMatch = text.match(/^skip\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (skipMatch && isAdmin(telegramId)) {
      const uuid = skipMatch[1].toLowerCase();
      try {
        let skipList: string[] = [];
        const existing = await getConfigValue('hardscape_skip_jobs');
        if (existing) {
          try { skipList = JSON.parse(existing); } catch { /* reset */ }
        }
        if (!skipList.includes(uuid)) {
          skipList.push(uuid);
          await setConfigValue('hardscape_skip_jobs', JSON.stringify(skipList));
          await bot.sendMessage(chatId, `✅ Job ${uuid} added to hardscape skip list.`);
          logger.info({ event: 'hardscape_skip_added', uuid });
        } else {
          await bot.sendMessage(chatId, `Job ${uuid} is already in the skip list.`);
        }
      } catch (err) {
        logger.error({ event: 'hardscape_skip_error', error: err instanceof Error ? err.message : String(err) });
        await bot.sendMessage(chatId, 'Failed to update skip list. Please try again.');
      }
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

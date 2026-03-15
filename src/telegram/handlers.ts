import TelegramBot from 'node-telegram-bot-api';
import { bot } from './bot';
import { getUserByTelegramId } from '../db/queries';
import { runAgent } from '../agent/core';
import { notifyUser } from '../tools/telegram_notify';
import logger from '../logger';

export function registerHandlers(): void {
  bot.on('message', async (msg: TelegramBot.Message) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    const text = msg.text;

    if (!telegramId) return;

    if (!text) {
      await bot.sendMessage(chatId, 'Please send text messages. Voice and photos are not supported yet.');
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

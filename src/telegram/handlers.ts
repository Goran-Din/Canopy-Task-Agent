import TelegramBot from 'node-telegram-bot-api';
import { bot } from './bot';
import { getUserByTelegramId } from '../db/queries';
import { runAgent } from '../agent/core';

export function registerHandlers(): void {
  bot.on('message', async (msg: TelegramBot.Message) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    const text = msg.text;

    if (!telegramId || !text) return;

    try {
      const user = await getUserByTelegramId(telegramId);

      if (!user) {
        await bot.sendMessage(
          chatId,
          'Hi! You are not registered in the Canopy Task Agent system. Please contact Goran to get access.'
        );
        return;
      }

      await bot.sendChatAction(chatId, 'typing');

      const reply = await runAgent(user, text);

      await bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('Handler error:', err);
      await bot.sendMessage(
        chatId,
        'Something went wrong. Please try again or contact Goran if the issue continues.'
      );
    }
  });
}

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { registerBot } from '../tools/telegram_notify';

export const bot = new TelegramBot(config.telegram.botToken, { polling: false });

registerBot({
  sendMessage: async (chatId: number | string, text: string, opts?: object) => {
    await bot.sendMessage(chatId, text, opts);
  },
});

export function getWebhookMiddleware() {
  return bot.processUpdate.bind(bot);
}

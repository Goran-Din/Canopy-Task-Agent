import { NotifyUserInput } from '../types';
import { config } from '../config';

let botInstance: { sendMessage: (chatId: number | string, text: string, opts?: object) => Promise<void> } | null = null;

export function registerBot(bot: { sendMessage: (chatId: number | string, text: string, opts?: object) => Promise<void> }): void {
  botInstance = bot;
}

function resolveTelegramId(recipient: string): number | string {
  const lower = recipient.toLowerCase();
  if (lower === 'group') return config.telegram.groupId;

  const ids: Record<string, number | string> = {
    goran: config.telegram.users.goran,
    mark: config.telegram.users.mark,
    hristina: config.telegram.users.hristina,
    erick: config.telegram.users.erick,
    marcin: config.telegram.users.marcin,
    gordana: config.telegram.users.gordana,
  };

  const id = ids[lower];
  if (!id || id === 'PENDING') {
    throw new Error(`Telegram ID for "${recipient}" is not configured yet.`);
  }
  return id as number | string;
}

export async function notifyUser(input: NotifyUserInput): Promise<{ success: boolean; message: string }> {
  if (!botInstance) {
    throw new Error('Bot not initialized. Call registerBot() first.');
  }

  const chatId = resolveTelegramId(input.recipient);

  const prefix: Record<string, string> = {
    task_assigned: '🔔',
    task_completed: '✅',
    invoice_ready: '💰',
    payment_received: '📄',
    urgent: '🚨',
  };

  const emoji = input.notification_type ? prefix[input.notification_type] || '' : '';
  const text = emoji ? `${emoji} ${input.message}` : input.message;

  await botInstance.sendMessage(chatId, text);

  return {
    success: true,
    message: `Notification sent to ${input.recipient}.`,
  };
}

import { NotifyUserInput } from '../types';
import { config } from '../config';
import logger from '../logger';

let botInstance: { sendMessage: (chatId: number | string, text: string, opts?: object) => Promise<void> } | null = null;

export function registerBot(bot: { sendMessage: (chatId: number | string, text: string, opts?: object) => Promise<void> }): void {
  botInstance = bot;
}

function resolveTelegramId(recipient: string): number | string | null {
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
    return null;
  }
  return id as number | string;
}

export async function notifyUser(input: NotifyUserInput): Promise<{ success: boolean; message: string }> {
  if (!botInstance) {
    throw new Error('Bot not initialized. Call registerBot() first.');
  }

  const chatId = resolveTelegramId(input.recipient);

  if (chatId === null) {
    const msg = `Unknown recipient "${input.recipient}". Valid names: erick, marcin, mark, hristina, gordana, goran, group`;
    logger.warn({ event: 'unknown_recipient', recipient: input.recipient });
    return { success: false, message: msg } as { success: boolean; message: string };
  }

  const prefix: Record<string, string> = {
    task_assigned: '🔔',
    task_completed: '✅',
    invoice_ready: '💰',
    payment_received: '📄',
    urgent: '🚨',
  };

  const emoji = input.notification_type ? prefix[input.notification_type] || '' : '';
  const text = emoji ? `${emoji} ${input.message}` : input.message;

  try {
    await botInstance.sendMessage(chatId, text);

    logger.info({ event: 'notification_sent', recipient: input.recipient, type: input.notification_type });

    return {
      success: true,
      message: `Notification sent to ${input.recipient}.`,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ event: 'notification_failed', recipient: input.recipient, error: error.message });
    return { success: false, message: `Could not send notification to ${input.recipient}: ${error.message}` };
  }
}

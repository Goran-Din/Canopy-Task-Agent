import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config = {
  port: parseInt(process.env.PORT || '3100'),
  environment: process.env.ENVIRONMENT || 'production',

  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    webhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
    groupId: required('TELEGRAM_GROUP_ID'),
    users: {
      goran: parseInt(required('TELEGRAM_USER_GORAN')),
      erick: process.env.TELEGRAM_USER_ERICK || 'PENDING',
      marcin: process.env.TELEGRAM_USER_MARCIN || 'PENDING',
      mark: parseInt(required('TELEGRAM_USER_MARK')),
      hristina: parseInt(required('TELEGRAM_USER_HRISTINA')),
      gordana: process.env.TELEGRAM_USER_GORDANA || 'PENDING',
    },
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
    fallbackModel: process.env.CLAUDE_FALLBACK_MODEL || 'claude-sonnet-4-6',
  },

  database: {
    url: required('DATABASE_URL'),
    poolMin: parseInt(process.env.DB_POOL_MIN || '2'),
    poolMax: parseInt(process.env.DB_POOL_MAX || '10'),
  },

  servicem8: {
    apiKey: required('SM8_API_KEY'),
    baseUrl: process.env.SM8_BASE_URL || 'https://api.servicem8.com/api_1.0',
  },

  vikunja: {
    baseUrl: required('VIKUNJA_BASE_URL'),
    apiToken: required('VIKUNJA_API_TOKEN'),
    projects: {
      fieldOps: parseInt(required('VIKUNJA_PROJECT_FIELD_OPS')),
      admin: parseInt(required('VIKUNJA_PROJECT_ADMIN')),
    },
    labels: {
      lawnCare: parseInt(required('VIKUNJA_LABEL_LAWN_CARE')),
      hardscape: parseInt(required('VIKUNJA_LABEL_HARDSCAPE')),
      snowRemoval: parseInt(required('VIKUNJA_LABEL_SNOW_REMOVAL')),
      irrigation: parseInt(required('VIKUNJA_LABEL_IRRIGATION')),
      cleanup: parseInt(required('VIKUNJA_LABEL_CLEANUP')),
      other: parseInt(required('VIKUNJA_LABEL_OTHER')),
    },
  },

  xero: {
    clientId: required('XERO_CLIENT_ID'),
    clientSecret: required('XERO_CLIENT_SECRET'),
    redirectUri: required('XERO_REDIRECT_URI'),
  },
};

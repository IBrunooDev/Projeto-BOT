import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  OWNER_ROLE_ID: z.string().min(1),
  ADMIN_ROLE_ID: z.string().min(1),
  UNVERIFIED_ROLE_ID: z.string().min(1),
  VERIFIED_ROLE_ID: z.string().min(1),
  VERIFICATION_CHANNEL_ID: z.string().min(1),
  VERIFICATION_LOG_CHANNEL_ID: z.string().min(1),
  PURCHASE_LOG_CHANNEL_ID: z.string().min(1),
  RESULTS_CHANNEL_ID: z.string().min(1),
  AUDIT_CHANNEL_ID: z.string().min(1),
  COUPON_LOG_CHANNEL_ID: z.string().optional().default(''),
  NOTICE_LOG_CHANNEL_ID: z.string().optional().default(''),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  DEFAULT_RESERVATION_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  DEFAULT_REVIEW_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  PURCHASE_COOLDOWN_MINUTES: z.coerce.number().int().min(0).max(1440).default(3),
  MIN_DISCORD_ACCOUNT_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
  // MIN_SERVER_MINUTES e a configuracao atual. MIN_SERVER_HOURS fica
  // aceito temporariamente para compatibilidade com .env de versoes antigas.
  MIN_SERVER_MINUTES: z.coerce.number().int().min(0).max(525600).optional(),
  MIN_SERVER_HOURS: z.coerce.number().int().min(0).max(8760).optional()
});

const parsed = envSchema.parse(process.env);

export const config = {
  ...parsed,
  MIN_SERVER_MINUTES: parsed.MIN_SERVER_MINUTES ??
    (parsed.MIN_SERVER_HOURS !== undefined ? parsed.MIN_SERVER_HOURS * 60 : 20)
};

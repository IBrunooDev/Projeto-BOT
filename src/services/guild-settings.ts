import { config } from '../config.js';
import { supabase } from './supabase.js';

export type GuildSettings = {
  guild_id: string;
  raffle_channel_id: string | null;
  verification_channel_id: string;
  verification_log_channel_id: string;
  purchase_log_channel_id: string;
  results_channel_id: string;
  audit_channel_id: string;
  owner_role_id: string;
  admin_role_id: string;
  unverified_role_id: string;
  verified_role_id: string;
  default_reservation_minutes: number;
  default_review_minutes: number;
};

const cache = new Map<string, GuildSettings>();

function envDefaults(guildId: string): GuildSettings {
  return {
    guild_id: guildId,
    raffle_channel_id: null,
    verification_channel_id: config.VERIFICATION_CHANNEL_ID,
    verification_log_channel_id: config.VERIFICATION_LOG_CHANNEL_ID,
    purchase_log_channel_id: config.PURCHASE_LOG_CHANNEL_ID,
    results_channel_id: config.RESULTS_CHANNEL_ID,
    audit_channel_id: config.AUDIT_CHANNEL_ID,
    owner_role_id: config.OWNER_ROLE_ID,
    admin_role_id: config.ADMIN_ROLE_ID,
    unverified_role_id: config.UNVERIFIED_ROLE_ID,
    verified_role_id: config.VERIFIED_ROLE_ID,
    default_reservation_minutes: config.DEFAULT_RESERVATION_MINUTES,
    default_review_minutes: config.DEFAULT_REVIEW_MINUTES
  };
}

export function getCachedSettings(guildId = config.DISCORD_GUILD_ID): GuildSettings {
  return cache.get(guildId) ?? envDefaults(guildId);
}

export async function loadGuildSettings(guildId = config.DISCORD_GUILD_ID): Promise<GuildSettings> {
  const defaults = envDefaults(guildId);
  const { data, error } = await supabase.from('guild_settings').select('*').eq('guild_id', guildId).maybeSingle();
  if (error) {
    // Em bancos antigos a tabela pode ainda não existir. O bot continua usando o .env.
    cache.set(guildId, defaults);
    return defaults;
  }
  const settings: GuildSettings = {
    ...defaults,
    ...(data ?? {}),
    guild_id: guildId,
    verification_channel_id: data?.verification_channel_id || defaults.verification_channel_id,
    verification_log_channel_id: data?.verification_log_channel_id || defaults.verification_log_channel_id,
    purchase_log_channel_id: data?.purchase_log_channel_id || defaults.purchase_log_channel_id,
    results_channel_id: data?.results_channel_id || defaults.results_channel_id,
    audit_channel_id: data?.audit_channel_id || defaults.audit_channel_id,
    owner_role_id: data?.owner_role_id || defaults.owner_role_id,
    admin_role_id: data?.admin_role_id || defaults.admin_role_id,
    unverified_role_id: data?.unverified_role_id || defaults.unverified_role_id,
    verified_role_id: data?.verified_role_id || defaults.verified_role_id,
    default_reservation_minutes: data?.default_reservation_minutes || defaults.default_reservation_minutes,
    default_review_minutes: data?.default_review_minutes || defaults.default_review_minutes
  };
  cache.set(guildId, settings);
  return settings;
}

export async function saveGuildSettings(guildId: string, patch: Partial<GuildSettings>): Promise<GuildSettings> {
  const current = getCachedSettings(guildId);
  const payload = {
    ...current,
    ...patch,
    guild_id: guildId,
    updated_at: new Date().toISOString()
  } as any;
  const { data, error } = await supabase.from('guild_settings').upsert(payload, { onConflict: 'guild_id' }).select('*').single();
  if (error) throw error;
  const merged = { ...current, ...data, guild_id: guildId } as GuildSettings;
  cache.set(guildId, merged);
  return merged;
}

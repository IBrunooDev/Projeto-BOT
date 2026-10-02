import { PermissionsBitField, type Client, type Guild, type GuildMember, type Role, type TextBasedChannel } from 'discord.js';
import { config } from '../config.js';
import { supabase } from './supabase.js';
import { getCachedSettings } from './guild-settings.js';

export const EXPECTED_SCHEMA_VERSION = '1.1.2';

function warn(message: string) {
  console.warn(`⚠️ ${message}`);
}

async function validateChannel(client: Client, guild: Guild, channelId: string, label: string, me: GuildMember) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    warn(`${label}: canal ${channelId} não existe ou não permite envio de mensagens.`);
    return;
  }
  const perms = 'permissionsFor' in channel ? channel.permissionsFor(me) : null;
  if (!perms) return;
  const required = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.ReadMessageHistory
  ];
  const missing = required.filter(p => !perms.has(p));
  if (missing.length) warn(`${label}: o bot não possui todas as permissões necessárias nesse canal.`);
}

const REQUIRED_TABLES = [
  'profiles',
  'verification_requests',
  'raffles',
  'purchases',
  'raffle_numbers',
  'purchase_numbers',
  'raffle_results',
  'audit_logs',
  'guild_settings'
] as const;

async function ensureSchemaVersion() {
  const { data: meta, error: metaError } = await supabase
    .from('app_meta')
    .select('value')
    .eq('key', 'schema_version')
    .maybeSingle();

  if (metaError) {
    throw new Error(`Banco incompatível ou não inicializado: ${metaError.message}. Execute BANCO-ZERADO-v1.1.7.sql no projeto Supabase indicado por SUPABASE_URL e depois VALIDAR-BANCO-v1.1.7.sql.`);
  }

  if (meta?.value === EXPECTED_SCHEMA_VERSION) {
    return meta.value;
  }

  // Instalações limpas podem ter as tabelas corretas mas estar sem a linha
  // de metadata por causa de uma execução antiga/incompleta do SQL. Nesse
  // caso, confirma o schema antes de registrar a versão automaticamente.
  for (const table of REQUIRED_TABLES) {
    const { error } = await supabase.from(table).select('*', { head: true, count: 'exact' }).limit(1);
    if (error) {
      throw new Error(`Banco incompatível: a tabela public.${table} não pôde ser validada (${error.message}). Execute BANCO-ZERADO-v1.1.7.sql em uma instalação limpa ou confira o projeto definido em SUPABASE_URL.`);
    }
  }

  const { error: repairError } = await supabase
    .from('app_meta')
    .upsert({ key: 'schema_version', value: EXPECTED_SCHEMA_VERSION, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  if (repairError) {
    throw new Error(`Versão do banco ausente e não foi possível registrá-la automaticamente: ${repairError.message}. Execute CORRIGIR-VERSAO-BANCO-v1.1.7.sql.`);
  }

  console.log(`⚙️ schema_version estava ausente e foi registrada automaticamente como ${EXPECTED_SCHEMA_VERSION} após validar as tabelas principais.`);
  return EXPECTED_SCHEMA_VERSION;
}

export async function validateStartup(client: Client) {
  const schemaVersion = await ensureSchemaVersion();
  console.log(`🗄️ Banco LGC Win v${schemaVersion} confirmado.`);

  const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID).catch(() => null);
  if (!guild) throw new Error(`Servidor ${config.DISCORD_GUILD_ID} não encontrado. Confira DISCORD_GUILD_ID e a instalação do bot.`);
  await guild.roles.fetch();
  const me = await guild.members.fetchMe();
  const settings = getCachedSettings(guild.id);

  const ownerRole = guild.roles.cache.get(settings.owner_role_id);
  const adminRole = guild.roles.cache.get(settings.admin_role_id);
  const unverifiedRole = guild.roles.cache.get(settings.unverified_role_id);
  const verifiedRole = guild.roles.cache.get(settings.verified_role_id);
  if (!ownerRole) warn('Cargo Dono configurado não foi encontrado.');
  if (!adminRole) warn('Cargo ADM configurado não foi encontrado.');
  if (!unverifiedRole) warn('Cargo Membro não verificado configurado não foi encontrado.');
  if (!verifiedRole) warn('Cargo Membro verificado configurado não foi encontrado.');

  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) warn('O bot não possui Gerenciar cargos.');
  if (!me.permissions.has(PermissionsBitField.Flags.ManageNicknames)) warn('O bot não possui Gerenciar apelidos.');
  if (unverifiedRole && me.roles.highest.comparePositionTo(unverifiedRole) <= 0) {
    warn('O cargo do LGC Win precisa ficar ACIMA do cargo Membro não verificado para conseguir aplicá-lo/removê-lo.');
  }
  if (verifiedRole && me.roles.highest.comparePositionTo(verifiedRole) <= 0) {
    warn('O cargo do LGC Win precisa ficar ACIMA do cargo Membro verificado para conseguir aplicá-lo/removê-lo.');
  }

  await validateChannel(client, guild, settings.verification_channel_id, 'Canal de verificação', me);
  await validateChannel(client, guild, settings.verification_log_channel_id, 'Canal de log de verificação', me);
  await validateChannel(client, guild, settings.purchase_log_channel_id, 'Canal de compras', me);
  await validateChannel(client, guild, settings.results_channel_id, 'Canal de resultados', me);
  await validateChannel(client, guild, settings.audit_channel_id, 'Canal de logs', me);
  if (config.COUPON_LOG_CHANNEL_ID) await validateChannel(client, guild, config.COUPON_LOG_CHANNEL_ID, 'Canal de log de cupons', me);
  if (config.NOTICE_LOG_CHANNEL_ID) await validateChannel(client, guild, config.NOTICE_LOG_CHANNEL_ID, 'Canal de log de avisos', me);
  if (settings.raffle_channel_id) await validateChannel(client, guild, settings.raffle_channel_id, 'Canal de rifas', me);

  console.log('🛡️ Validação inicial concluída. Avisos acima não desligam o bot, mas devem ser corrigidos.');
}

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type TextBasedChannel } from 'discord.js';
import { money } from '../utils/money.js';
import { getCachedSettings } from './guild-settings.js';
import { supabase } from './supabase.js';

async function getCreatorDisplay(client: Client, raffle: any): Promise<string> {
  const fallback = `<@${raffle.created_by}>`;
  if (!raffle.created_by || !raffle.guild_id) return fallback;

  const guild = client.guilds.cache.get(String(raffle.guild_id)) ?? await client.guilds.fetch(String(raffle.guild_id)).catch(() => null);
  if (!guild) return fallback;

  const member = await guild.members.fetch(String(raffle.created_by)).catch(() => null);
  if (!member) return fallback;

  const settings = getCachedSettings(guild.id);
  const roleLabel = member.roles.cache.has(settings.owner_role_id)
    ? 'Dono'
    : member.roles.cache.has(settings.admin_role_id)
      ? 'ADM'
      : 'Usuário';
  const name = member.displayName || member.user.globalName || member.user.username;
  return `${roleLabel} | ${name}`;
}

export async function buildRaffleMessage(client: Client, raffleId: string) {
  const { data: raffle, error } = await supabase.from('raffles').select('*').eq('id', raffleId).single();
  if (error || !raffle) throw new Error('Rifa não encontrada.');

  const { data: numbers } = await supabase.from('raffle_numbers').select('number,status').eq('raffle_id', raffleId);
  const counts = { available: 0, reserved: 0, sold: 0 };
  for (const n of numbers ?? []) counts[n.status as keyof typeof counts]++;

  const statusLabel: Record<string,string> = {
    active: '🟢 Ativa', paused: '⏸️ Pausada', closed: '🔒 Vendas encerradas', drawn: '🏆 Sorteada', cancelled: '❌ Cancelada'
  };
  const creatorDisplay = await getCreatorDisplay(client, raffle);
  const availableNumbers = (numbers ?? [])
    .filter((n: any) => n.status === 'available')
    .map((n: any) => Number(n.number))
    .sort((a: number, b: number) => a - b);
  const previewNumbers = availableNumbers.slice(0, 100);
  const availablePreview = availableNumbers.length
    ? previewNumbers.map((n: number) => `#${n}`).join(', ') + (availableNumbers.length > previewNumbers.length ? ` ... e mais ${availableNumbers.length - previewNumbers.length}` : '')
    : 'Nenhum número disponível no momento.';
  const embed = new EmbedBuilder()
    .setTitle(`🎟️ ${raffle.name}`)
    .setDescription(raffle.description)
    .addFields(
      { name: 'Status', value: statusLabel[raffle.status] ?? raffle.status, inline: true },
      { name: '💰 Valor por número', value: money(raffle.number_price), inline: true },
      { name: '🟢 Disponíveis', value: String(counts.available), inline: true },
      { name: '🟡 Reservados', value: String(counts.reserved), inline: true },
      { name: '🔴 Vendidos', value: String(counts.sold), inline: true },
      { name: '📦 Limite por reserva', value: String(raffle.max_numbers_per_reservation), inline: true },
      { name: '⏱️ Reserva', value: `${raffle.reservation_minutes} min`, inline: true },
      { name: '🆔 Rifa ID', value: `\`${raffle.id}\``, inline: false },
      { name: '👤 Criada por', value: `**${creatorDisplay}**`, inline: false },
      { name: '🔢 Números disponíveis', value: availablePreview.slice(0, 1024), inline: false }
    )
    .setFooter({ text: 'LGC Win • Rifa' });

  if (raffle.image_url) embed.setImage(raffle.image_url);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`buy:${raffle.id}`).setLabel('Escolher números').setEmoji('🎟️').setStyle(ButtonStyle.Success).setDisabled(raffle.status !== 'active'),
    new ButtonBuilder().setCustomId(`numbers:view:${raffle.id}:0`).setLabel('Ver números').setEmoji('🔢').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rank:${raffle.id}`).setLabel('Ranking').setEmoji('🏆').setStyle(ButtonStyle.Secondary)
  );
  return { raffle, embed, row };
}

export async function publishRaffle(client: Client, raffleId: string, channel: TextBasedChannel) {
  if (!channel.isSendable()) throw new Error('O canal escolhido não permite o envio de mensagens pelo bot.');
  const { embed, row } = await buildRaffleMessage(client, raffleId);
  const msg = await channel.send({ embeds: [embed], components: [row] });
  await supabase.from('raffles').update({ panel_channel_id: msg.channelId, panel_message_id: msg.id }).eq('id', raffleId);
  return msg;
}

export async function refreshRafflePanel(client: Client, raffleId: string) {
  const { data: raffle } = await supabase.from('raffles').select('panel_channel_id,panel_message_id').eq('id', raffleId).single();
  if (!raffle?.panel_channel_id || !raffle?.panel_message_id) return;
  const channel = await client.channels.fetch(raffle.panel_channel_id).catch(() => null);
  if (!channel?.isTextBased() || !('messages' in channel)) return;
  const msg = await channel.messages.fetch(raffle.panel_message_id).catch(() => null);
  if (!msg) return;
  const { embed, row } = await buildRaffleMessage(client, raffleId);
  await msg.edit({ embeds: [embed], components: [row] }).catch(() => null);
}

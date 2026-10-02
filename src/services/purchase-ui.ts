import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client } from 'discord.js';
import { money } from '../utils/money.js';
import { supabase } from './supabase.js';
import { getCachedSettings } from './guild-settings.js';

export async function purchaseDetails(purchaseId: string) {
  const { data: purchase, error } = await supabase
    .from('purchases')
    .select('*, raffles(name), purchase_numbers(number)')
    .eq('id', purchaseId)
    .single();
  if (error || !purchase) throw new Error('Compra não encontrada.');
  const { data: profile } = await supabase.from('profiles').select('mta_name,mta_id').eq('discord_id', purchase.discord_id).single();
  return { ...purchase, profile } as any;
}


export async function buildPurchaseEmbed(purchaseId: string) {
  const p = await purchaseDetails(purchaseId);
  if (!p.profile) {
    const { data: profile } = await supabase.from('profiles').select('mta_name,mta_id').eq('discord_id', p.discord_id).single();
    p.profile = profile;
  }
  const nums = (p.purchase_numbers ?? []).map((x: any) => x.number).sort((a: number,b: number)=>a-b);
  const statusMap: Record<string,string> = {
    pending: '⏳ Aguardando um ADM assumir',
    in_review: `🔎 Em análise por <@${p.claimed_by}>`,
    approved: `✅ Aprovada por <@${p.approved_by}>`,
    rejected: `❌ Recusada por <@${p.rejected_by}>`,
    expired: '⌛ Reserva expirada'
  };
  const embed = new EmbedBuilder()
    .setTitle('🧾 Compra de Rifa')
    .addFields(
      { name: '🎟️ Rifa', value: p.raffles?.name ?? p.raffle_id, inline: false },
      { name: '👤 Jogador', value: `${p.profile?.mta_name ?? 'N/D'} | ${p.profile?.mta_id ?? 'N/D'} (<@${p.discord_id}>)`, inline: false },
      { name: '📱 Telefone no jogo', value: p.game_phone, inline: true },
      { name: '📦 Quantidade', value: String(nums.length), inline: true },
      { name: '🔢 Números', value: nums.join(', ') || 'N/D', inline: false },
      { name: '💰 Valor original', value: money(p.subtotal), inline: true },
      { name: '🎫 Cupom', value: p.coupon_code_snapshot ? `${p.coupon_code_snapshot} (${p.discount_percent_snapshot}%)` : 'Nenhum', inline: true },
      { name: '📉 Desconto', value: money(p.discount_amount), inline: true },
      { name: '💵 Valor final', value: money(p.total), inline: true },
      { name: 'Status', value: statusMap[p.status] ?? p.status, inline: false }
    )
    .setFooter({ text: `Compra ID: ${p.id}` })
    .setTimestamp(new Date(p.created_at));
  if (p.rejection_reason) embed.addFields({ name: '📝 Motivo da recusa', value: p.rejection_reason });
  return { purchase: p, embed };
}

export function purchaseButtons(p: any) {
  if (p.status === 'pending') {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`claim:${p.id}`).setLabel('Assumir análise').setEmoji('👮').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ownerclaim:${p.id}`).setLabel('Dono: assumir').setEmoji('👑').setStyle(ButtonStyle.Secondary)
    )];
  }
  if (p.status === 'in_review') {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`approve:${p.id}`).setLabel('Aprovar compra').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`reject:${p.id}`).setLabel('Recusar compra').setEmoji('❌').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`release:${p.id}`).setLabel('Liberar análise').setEmoji('🔓').setStyle(ButtonStyle.Secondary)
    )];
  }
  return [];
}

export async function postPurchaseForReview(client: Client, purchaseId: string) {
  const guildId = client.guilds.cache.first()?.id;
  if (!guildId) throw new Error('Servidor não encontrado.');
  const channel = await client.channels.fetch(getCachedSettings(guildId).purchase_log_channel_id);
  if (!channel?.isTextBased() || !channel.isSendable()) throw new Error('Canal PURCHASE_LOG_CHANNEL_ID inválido ou sem suporte para envio de mensagens.');
  const { purchase, embed } = await buildPurchaseEmbed(purchaseId);
  const msg = await channel.send({ embeds: [embed], components: purchaseButtons(purchase) });
  await supabase.from('purchases').update({ review_channel_id: msg.channelId, review_message_id: msg.id }).eq('id', purchase.id);
  await supabase.from('audit_logs').insert({
    action: 'COMPRA_ENVIADA_PARA_ANALISE',
    target_discord_id: purchase.discord_id,
    entity_type: 'purchase',
    entity_id: purchase.id,
    metadata: { discord_message_id: msg.id }
  });
  return msg;
}


export async function refreshPurchaseReviewMessage(client: Client, purchaseId: string) {
  const { purchase, embed } = await buildPurchaseEmbed(purchaseId);
  if (!purchase.review_channel_id || !purchase.review_message_id) return;
  const channel = await client.channels.fetch(purchase.review_channel_id).catch(() => null);
  if (!channel?.isTextBased() || !('messages' in channel)) return;
  const msg = await channel.messages.fetch(purchase.review_message_id).catch(() => null);
  if (!msg) return;
  await msg.edit({ embeds: [embed], components: purchaseButtons(purchase) }).catch(() => null);
}

import type { Client } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { supabase } from './supabase.js';
import { getCachedSettings } from './guild-settings.js';
import { money } from '../utils/money.js';
import { config } from '../config.js';

export async function audit(client: Client, action: string, actor: string | null, details: Record<string, unknown> = {}, target?: string | null, entityType?: string, entityId?: string) {
  await supabase.from('audit_logs').insert({
    action,
    actor_discord_id: actor,
    target_discord_id: target ?? null,
    entity_type: entityType ?? null,
    entity_id: entityId ?? null,
    metadata: details
  });

  const guildId = client.guilds.cache.first()?.id;
  const auditChannelId = guildId ? getCachedSettings(guildId).audit_channel_id : null;
  const couponChannelId = config.COUPON_LOG_CHANNEL_ID || '';
  const noticeChannelId = config.NOTICE_LOG_CHANNEL_ID || '';
  const isCouponAction = action.startsWith('CUPOM_');
  const isNoticeAction = action === 'AVISO_ENVIADO';
  const targetChannelId = isCouponAction
    ? (couponChannelId || auditChannelId)
    : isNoticeAction
      ? (noticeChannelId || auditChannelId)
      : auditChannelId;
  let channel = targetChannelId ? await client.channels.fetch(targetChannelId).catch(() => null) : null;
  if (!channel && (isCouponAction || isNoticeAction) && auditChannelId && targetChannelId !== auditChannelId) {
    channel = await client.channels.fetch(auditChannelId).catch(() => null);
  }
  if (channel?.isTextBased() && channel.isSendable()) {
    let embed: EmbedBuilder;

    if (action === 'CUPOM_CRIADO') {
      const formatDate = (value: unknown) => {
        if (!value) return 'Sem validade';
        const date = new Date(String(value));
        if (Number.isNaN(date.getTime())) return String(value);
        return new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          dateStyle: 'short',
          timeStyle: 'short'
        }).format(date);
      };
      const creatorId = String(details.criador_discord_id ?? actor ?? '');
      const expires = details.validade ? formatDate(details.validade) : 'Sem validade';
      const createdAt = details.criado_em ? formatDate(details.criado_em) : formatDate(new Date().toISOString());
      embed = new EmbedBuilder()
        .setTitle('🎫 Cupom criado')
        .setDescription('Um novo cupom foi criado no LGC Win.')
        .addFields(
          { name: '🏷️ Nome do cupom', value: String(details.nome ?? 'N/D'), inline: false },
          { name: '🔑 Código', value: `\`${String(details.codigo ?? 'N/D')}\``, inline: true },
          { name: '💸 Desconto', value: String(details.desconto ?? 'N/D'), inline: true },
          { name: '👥 Usos', value: String(details.usos ?? '0/N/D'), inline: true },
          { name: '👤 Limite por pessoa', value: String(details.limite_por_pessoa ?? 'N/D'), inline: true },
          { name: '🔢 Mínimo de números', value: String(details.minimo_numeros ?? 'N/D'), inline: true },
          { name: '📅 Data de validade', value: expires, inline: true },
          { name: '🕐 Data e hora de criação', value: createdAt, inline: false },
          { name: '🎟️ Rifa', value: String(details.rifa_id ?? 'Todas as rifas'), inline: false },
          { name: '👮 Criado por', value: creatorId ? `<@${creatorId}>` : 'N/D', inline: false }
        )
        .setFooter({ text: 'LGC Win • Log de criação de cupom' })
        .setTimestamp();
    } else if (action === 'CUPOM_EDITADO') {
      const formatDate = (value: unknown) => {
        if (!value) return 'Sem validade';
        const date = new Date(String(value));
        if (Number.isNaN(date.getTime())) return String(value);
        return new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          dateStyle: 'short',
          timeStyle: 'short'
        }).format(date);
      };

      const code = String(details.codigo ?? '').trim().toUpperCase();
      const { data: coupon } = code
        ? await supabase.from('coupons')
            .select('id,name,code,discount_percent,min_numbers,max_uses,max_uses_per_user,expires_at,raffle_id,created_at,updated_at,created_by')
            .eq('code', code)
            .is('deleted_at', null)
            .maybeSingle()
        : { data: null };

      let usageCount = 0;
      if (coupon?.id) {
        const { count } = await supabase.from('purchases')
          .select('id', { count: 'exact', head: true })
          .eq('coupon_id', coupon.id)
          .eq('status', 'approved');
        usageCount = count ?? 0;
      }

      const maxUses = coupon?.max_uses ?? details.max_uses ?? 'N/D';
      const creatorId = String(coupon?.created_by ?? details.criador_discord_id ?? '');
      const editorId = String(actor ?? '');
      const editedAt = coupon?.updated_at ?? details.updated_at ?? new Date().toISOString();
      const expires = coupon?.expires_at ? formatDate(coupon.expires_at) : 'Sem validade';

      embed = new EmbedBuilder()
        .setTitle('🎫 Cupom editado')
        .setDescription('Um cupom foi alterado no LGC Win.')
        .addFields(
          { name: '🏷️ Nome do cupom', value: String(coupon?.name ?? details.nome ?? 'N/D'), inline: false },
          { name: '🔑 Código', value: `\`${String(coupon?.code ?? code ?? 'N/D')}\``, inline: true },
          { name: '💸 Desconto', value: coupon?.discount_percent != null ? `${coupon.discount_percent}%` : String(details.discount_percent ?? 'N/D'), inline: true },
          { name: '👥 Usos', value: `${usageCount}/${String(maxUses)}`, inline: true },
          { name: '👤 Limite por pessoa', value: String(coupon?.max_uses_per_user ?? details.max_uses_per_user ?? 'N/D'), inline: true },
          { name: '🔢 Mínimo de números', value: String(coupon?.min_numbers ?? details.min_numbers ?? 'N/D'), inline: true },
          { name: '📅 Data de validade', value: expires, inline: true },
          { name: '🕐 Data e hora da edição', value: formatDate(editedAt), inline: false },
          { name: '🎟️ Rifa', value: String(coupon?.raffle_id ?? details.rifa_id ?? 'Todas as rifas'), inline: false },
          { name: '👮 Editado por', value: editorId ? `<@${editorId}>` : 'N/D', inline: false }
        )
        .setFooter({ text: 'LGC Win • Log de edição de cupom' })
        .setTimestamp();
    } else if (action === 'AVISO_ENVIADO') {
      const imageUrl = typeof details.imagem_url === 'string' ? details.imagem_url.trim() : '';
      const title = String(details.titulo ?? '📢 Aviso');
      const description = String(details.descricao ?? 'Sem descrição.').trim() || 'Sem descrição.';
      const actorId = String(actor ?? details.enviado_por ?? '').trim();
      const channelId = String(details.canal_id ?? '').trim();

      embed = new EmbedBuilder()
        .setTitle('📢 Aviso enviado')
        .setDescription(description.slice(0, 4096))
        .addFields(
          { name: '📌 Título', value: title.slice(0, 1024), inline: false },
          { name: '🕐 Data e hora', value: new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            dateStyle: 'short',
            timeStyle: 'short'
          }).format(new Date()), inline: true },
          { name: '👤 Enviado por', value: actorId ? `<@${actorId}>` : 'N/D', inline: true },
          { name: '📍 Canal do aviso', value: channelId ? `<#${channelId}>` : 'N/D', inline: true }
        )
        .setFooter({ text: 'LGC Win • Log de avisos' })
        .setTimestamp();

      if (/^https?:\/\//i.test(imageUrl)) embed.setImage(imageUrl);
    } else if (action === 'RIFA_EDITADA') {
      const imageUrl = typeof details.foto_premio === 'string' ? details.foto_premio : '';
      const isValidImageUrl = /^https?:\/\//i.test(imageUrl);
      const price = Number(details.valor_por_numero);
      const priceText = Number.isFinite(price) ? money(price) : String(details.valor_por_numero ?? 'N/D');
      const maxUser = details.limite_por_usuario == null || details.limite_por_usuario === 'sem limite'
        ? 'Sem limite'
        : String(details.limite_por_usuario);
      const changes = Array.isArray(details.alteracoes)
        ? details.alteracoes.map(String)
        : String(details.alteracoes ?? '').split(',').map(v => v.trim()).filter(Boolean);
      const labels: Record<string, string> = {
        name: 'Nome',
        description: 'Descrição',
        number_price: 'Valor por número',
        image_url: 'Foto do prêmio',
        max_numbers_per_reservation: 'Máximo por reserva',
        max_numbers_per_user: 'Máximo por usuário',
        reservation_minutes: 'Minutos da reserva',
        status: 'Status'
      };
      const changesText = changes.length
        ? changes.map(key => `• ${labels[key] ?? key}`).join('\n')
        : 'Nenhuma alteração informada';
      const actorId = String(details.editada_por ?? '');

      embed = new EmbedBuilder()
        .setTitle('✏️ Rifa editada')
        .setDescription('Uma rifa foi alterada no LGC Win.')
        .addFields(
          { name: '🎟️ Rifa', value: `**${String(details.nome_atual ?? details.nome_anterior ?? 'N/D')}**`, inline: false },
          { name: '📌 Nome anterior', value: String(details.nome_anterior ?? 'N/D'), inline: true },
          { name: '✏️ Alterações', value: changesText.slice(0, 1024), inline: false },
          { name: '📝 Descrição atual', value: String(details.descricao_atual ?? 'Sem descrição').slice(0, 1024), inline: false },
          { name: '🔢 Números', value: String(details.quantidade_numeros ?? 'N/D'), inline: true },
          { name: '💰 Valor por número', value: priceText, inline: true },
          { name: '📦 Limite por reserva', value: String(details.limite_por_reserva ?? 'N/D'), inline: true },
          { name: '👤 Limite por usuário', value: maxUser, inline: true },
          { name: '⏱️ Minutos da reserva', value: `${String(details.minutos_reserva ?? 'N/D')} min`, inline: true },
          { name: '📊 Status', value: String(details.status ?? 'N/D'), inline: true },
          { name: '👤 Editada por', value: actorId ? `<@${actorId}>` : 'N/D', inline: false },
          { name: '🆔 ID da rifa', value: `\`${String(details.rifa_id ?? 'N/D')}\``, inline: false }
        )
        .setFooter({ text: 'LGC Win • Log de auditoria' })
        .setTimestamp();

      if (isValidImageUrl) embed.setImage(imageUrl);
    } else if (action === 'RIFA_CRIADA') {
      const imageUrl = typeof details.foto_premio === 'string' ? details.foto_premio : '';
      const isValidImageUrl = /^https?:\/\//i.test(imageUrl);
      const price = Number(details.valor_por_numero);
      const priceText = Number.isFinite(price) ? money(price) : String(details.valor_por_numero ?? 'N/D');
      const maxUser = details.limite_por_usuario == null || details.limite_por_usuario === 'sem limite'
        ? 'Sem limite'
        : String(details.limite_por_usuario);
      const creator = String(details.criada_por ?? 'N/D');
      const creatorId = String(details.criador_discord_id ?? '');

      embed = new EmbedBuilder()
        .setTitle('🎟️ Rifa criada')
        .setDescription('Uma nova rifa foi criada no LGC Win.')
        .addFields(
          { name: '🎟️ Rifa', value: `**${String(details.nome ?? 'N/D')}**`, inline: false },
          { name: '📝 Descrição', value: String(details.descricao ?? 'Sem descrição').slice(0, 1024), inline: false },
          { name: '🔢 Números', value: String(details.quantidade_numeros ?? 'N/D'), inline: true },
          { name: '💰 Valor por número', value: priceText, inline: true },
          { name: '⏱️ Tempo de reserva', value: `${String(details.minutos_reserva ?? 'N/D')} min`, inline: true },
          { name: '📦 Limite por reserva', value: String(details.limite_por_reserva ?? 'N/D'), inline: true },
          { name: '👤 Limite por usuário', value: maxUser, inline: true },
          { name: '👑 Criada por', value: creatorId ? `${creator} (<@${creatorId}>)` : creator, inline: false },
          { name: '🆔 ID da rifa', value: `\`${String(details.rifa_id ?? 'N/D')}\``, inline: false }
        )
        .setFooter({ text: 'LGC Win • Log de auditoria' })
        .setTimestamp();

      if (isValidImageUrl) embed.setImage(imageUrl);
    } else {
      embed = new EmbedBuilder()
        .setTitle(`📋 ${action}`)
        .setDescription(Object.entries(details).map(([k, v]) => `**${k}:** ${String(v)}`).join('\n').slice(0, 3800) || 'Sem detalhes')
        .setTimestamp();
    }

    await channel.send({ embeds: [embed] }).catch(() => null);
  }
}

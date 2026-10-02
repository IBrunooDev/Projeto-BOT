import { gzipSync } from 'node:zlib';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  FileUploadBuilder,
  GuildMember,
  LabelBuilder,
  ModalBuilder,
  MessageFlags,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction
} from 'discord.js';
import { config } from '../config.js';
import { supabase } from '../services/supabase.js';
import { audit } from '../services/audit.js';
import { buildRaffleMessage, publishRaffle, refreshRafflePanel } from '../services/raffle-ui.js';
import { buildPurchaseEmbed, postPurchaseForReview, purchaseButtons, refreshPurchaseReviewMessage } from '../services/purchase-ui.js';
import { isAdmin, isOwner } from '../utils/permissions.js';
import { money } from '../utils/money.js';
import { uploadPrizeImage } from '../services/prize-image.js';
import { getCachedSettings, saveGuildSettings, type GuildSettings } from '../services/guild-settings.js';
import { applyVerificationRoles, syncMemberVerificationState } from '../services/member-roles.js';

function rpcOne<T = any>(data: T | T[] | null): T | null {
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

function errMessage(error: any) {
  return error?.message || error?.details || String(error || 'Erro desconhecido.');
}

async function fetchAllTableRows(table: string) {
  const pageSize = 1000;
  const rows: any[] = [];
  let from = 0;
  let expectedCount: number | null = null;

  while (true) {
    const to = from + pageSize - 1;
    const query = supabase.from(table).select('*', from === 0 ? { count: 'exact' } : undefined).range(from, to);
    const { data, error, count } = await query;
    if (error) throw new Error(`Falha no backup da tabela ${table}: ${error.message}`);
    if (from === 0) expectedCount = count ?? null;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }

  if (expectedCount != null && rows.length !== expectedCount) {
    throw new Error(`Backup incompleto em ${table}: esperado ${expectedCount}, coletado ${rows.length}.`);
  }
  return { rows, count: rows.length };
}

async function deny(interaction: any, message = '❌ Você não tem permissão para usar esta opção.') {
  if (interaction.deferred || interaction.replied) return interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

function parseNumbers(input: string) {
  return input.split(/[\s,;]+/).filter(Boolean).map(x => Number(x));
}

async function getAvailableNumbers(raffleId: string) {
  const { data, error } = await supabase
    .from('raffle_numbers')
    .select('number')
    .eq('raffle_id', raffleId)
    .eq('status', 'available')
    .order('number', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => Number(row.number));
}

async function showNumberPicker(interaction: ButtonInteraction, raffleId: string, page = 0) {
  const { data: raffle, error } = await supabase
    .from('raffles')
    .select('id,name,status,max_numbers_per_reservation')
    .eq('id', raffleId)
    .is('deleted_at', null)
    .single();
  if (error || !raffle) return deny(interaction, '❌ Rifa não encontrada.');
  if (raffle.status !== 'active') return deny(interaction, '❌ Esta rifa não está aceitando compras no momento.');

  const available = await getAvailableNumbers(raffleId);
  if (!available.length) return deny(interaction, '❌ Não há números disponíveis nesta rifa.');

  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(available.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageNumbers = available.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const maxSelectable = Math.min(Math.max(Number(raffle.max_numbers_per_reservation) || 1, 1), pageNumbers.length, 25);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`numbers:select:${raffleId}:${safePage}`)
    .setPlaceholder(maxSelectable === 1 ? 'Selecione 1 número' : `Selecione até ${maxSelectable} números`)
    .setMinValues(1)
    .setMaxValues(maxSelectable)
    .addOptions(pageNumbers.map((number: number) => ({
      label: `#${number}`,
      value: String(number),
      description: 'Número disponível'
    })));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`numbers:view:${raffleId}:${safePage - 1}`).setLabel('Anterior').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId(`numbers:view:${raffleId}:${safePage + 1}`).setLabel('Próxima').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages - 1)
  );

  const embed = new EmbedBuilder()
    .setTitle(`🔢 Números — ${raffle.name}`)
    .setDescription(
      `🟢 **${available.length}** número(s) disponível(is).\n` +
      `Página **${safePage + 1}/${totalPages}**\n\n` +
      `Escolha os números abaixo. O limite desta rifa é de **${raffle.max_numbers_per_reservation}** por reserva.\n` +
      `A disponibilidade é validada novamente no momento da reserva.`
    );

  const payload = { embeds: [embed], components: [row, nav] };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function showPurchaseModalFromNumbers(interaction: StringSelectMenuInteraction, raffleId: string, numbers: string[]) {
  const modal = new ModalBuilder().setCustomId(`buy:modal:${raffleId}`).setTitle('Comprar números da rifa');
  const numbersInput = new TextInputBuilder()
    .setCustomId('numbers')
    .setLabel('Números escolhidos')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(500)
    .setValue(numbers.join(', '));
  const phone = new TextInputBuilder().setCustomId('phone').setLabel('Telefone dentro do jogo (máx. 6 dígitos)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6);
  const coupon = new TextInputBuilder().setCustomId('coupon').setLabel('Cupom (opcional)').setPlaceholder('Deixe vazio se não tiver').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(30);
  addModalComponents(modal,
    new ActionRowBuilder<TextInputBuilder>().addComponents(numbersInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(phone),
    new ActionRowBuilder<TextInputBuilder>().addComponents(coupon)
  );
  return interaction.showModal(modal);
}

async function ensureAdmin(interaction: Interaction) {
  if (!interaction.inGuild()) return false;
  return isAdmin(interaction.member as GuildMember);
}

async function purchaseEligibilityError(interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction): Promise<string | null> {
  if (!interaction.inGuild()) return '❌ As compras só podem ser feitas dentro do servidor.';

  const member = interaction.member as GuildMember;
  const accountDays = (Date.now() - interaction.user.createdTimestamp) / 86400000;
  const joinedMinutes = member.joinedTimestamp ? (Date.now() - member.joinedTimestamp) / 60000 : 0;

  // Revalida as proteções também na hora da compra. Isso evita que alguém
  // verificado saia/reentre no servidor e contorne o tempo mínimo de entrada.
  if (config.MIN_DISCORD_ACCOUNT_DAYS > 0 && accountDays < config.MIN_DISCORD_ACCOUNT_DAYS) {
    return `❌ Sua conta do Discord precisa ter pelo menos ${config.MIN_DISCORD_ACCOUNT_DAYS} dias para comprar rifas.`;
  }
  if (config.MIN_SERVER_MINUTES > 0 && joinedMinutes < config.MIN_SERVER_MINUTES) {
    return `❌ Você precisa estar no servidor há pelo menos ${config.MIN_SERVER_MINUTES} minuto(s) antes de comprar.`;
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('verified,blocked_until')
    .eq('discord_id', interaction.user.id)
    .maybeSingle();
  if (error) return '❌ Não foi possível validar sua conta agora. Tente novamente em alguns segundos.';
  if (!profile?.verified) return '❌ Você precisa ter a verificação aprovada antes de comprar números.';
  if (profile.blocked_until && new Date(profile.blocked_until).getTime() > Date.now()) {
    const unix = Math.floor(new Date(profile.blocked_until).getTime() / 1000);
    return `🚫 Você está bloqueado temporariamente das rifas até <t:${unix}:F>.`;
  }

  // O Dono do servidor/bot fica isento do cooldown entre compras.
  // O cooldown dos demais usuários é persistido no banco pela data da última compra.
  if (!isOwner(member) && config.PURCHASE_COOLDOWN_MINUTES > 0) {
    const { data: lastPurchase, error: cooldownError } = await supabase
      .from('purchases')
      .select('created_at')
      .eq('discord_id', interaction.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cooldownError) {
      return '❌ Não foi possível verificar o intervalo entre compras. Tente novamente em alguns segundos.';
    }

    if (lastPurchase?.created_at) {
      const cooldownMs = config.PURCHASE_COOLDOWN_MINUTES * 60_000;
      const nextPurchaseAt = new Date(lastPurchase.created_at).getTime() + cooldownMs;
      if (nextPurchaseAt > Date.now()) {
        const unix = Math.floor(nextPurchaseAt / 1000);
        return `⏳ Você precisa esperar **${config.PURCHASE_COOLDOWN_MINUTES} minuto(s)** entre compras. Poderá comprar novamente <t:${unix}:R>.`;
      }
    }
  }

  return null;
}


async function validateSettingsDraft(client: Client, guildId: string, draft: Partial<GuildSettings>) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error('Servidor não encontrado pelo bot.');
  await guild.roles.fetch();

  const channels: Array<[keyof GuildSettings, string]> = [
    ['verification_channel_id', 'canal público de verificação'],
    ['verification_log_channel_id', 'canal de log de verificação'],
    ['purchase_log_channel_id', 'canal de log de compras'],
    ['results_channel_id', 'canal de resultados'],
    ['audit_channel_id', 'canal de logs gerais']
  ];
  if (draft.raffle_channel_id) channels.push(['raffle_channel_id', 'canal público de rifas']);

  for (const [key, label] of channels) {
    const id = draft[key] as string | null | undefined;
    if (!id) throw new Error(`Informe o ${label}.`);
    const channel = await client.channels.fetch(id).catch(() => null);
    if (!channel?.isTextBased() || !channel.isSendable()) throw new Error(`O ${label} (${id}) não existe ou não permite envio de mensagens.`);
  }

  const roles: Array<[keyof GuildSettings, string]> = [
    ['owner_role_id', 'cargo Dono'],
    ['admin_role_id', 'cargo ADM'],
    ['unverified_role_id', 'cargo Membro não verificado'],
    ['verified_role_id', 'cargo Membro verificado']
  ];
  for (const [key, label] of roles) {
    const id = draft[key] as string | undefined;
    if (!id || !guild.roles.cache.has(id)) throw new Error(`O ${label} (${id ?? 'vazio'}) não foi encontrado.`);
  }

  const me = await guild.members.fetchMe();
  const unverifiedRole = guild.roles.cache.get(String(draft.unverified_role_id));
  const verifiedRole = guild.roles.cache.get(String(draft.verified_role_id));
  if (unverifiedRole && me.roles.highest.comparePositionTo(unverifiedRole) <= 0) {
    throw new Error('O cargo do LGC Win precisa ficar acima do cargo Membro não verificado antes de salvar a configuração.');
  }
  if (verifiedRole && me.roles.highest.comparePositionTo(verifiedRole) <= 0) {
    throw new Error('O cargo do LGC Win precisa ficar acima do cargo Membro verificado antes de salvar a configuração.');
  }
}

type RaffleDraft = {
  guildId: string;
  userId: string;
  name: string;
  description: string;
  imageUrl: string;
  numberCount: number;
  numberPrice: number;
};

type RaffleEditDraft = {
  guildId: string;
  userId: string;
  raffleId: string;
  raffleName: string;
  changes: Record<string, any>;
  current: {
    maxNumbersPerReservation: number;
    maxNumbersPerUser: number | null;
    reservationMinutes: number;
    status: string;
  };
};

type CouponDraft = {
  userId: string;
  code: string;
  discount: number;
  minNumbers: number;
  maxUses: number;
  maxUsesPerUser: number;
};

const raffleDrafts = new Map<string, RaffleDraft>();
const raffleEditDrafts = new Map<string, RaffleEditDraft>();
const couponDrafts = new Map<string, CouponDraft>();

type ConfigDraft = Partial<GuildSettings> & { userId: string; guildId: string };
const configDrafts = new Map<string, ConfigDraft>();

function draftKey(guildId: string | null, userId: string) {
  return `${guildId ?? 'dm'}:${userId}`;
}

function input(
  customId: string,
  label: string,
  options: {
    placeholder?: string;
    required?: boolean;
    maxLength?: number;
    minLength?: number;
    paragraph?: boolean;
    value?: string;
  } = {}
) {
  const field = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(options.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(options.required ?? true);
  if (options.placeholder) field.setPlaceholder(options.placeholder);
  if (options.maxLength) field.setMaxLength(options.maxLength);
  if (options.minLength) field.setMinLength(options.minLength);
  if (options.value) field.setValue(options.value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(field);
}


function addModalComponents(modal: ModalBuilder, ...components: any[]) {
  const builder = modal as any;

  // Compatibilidade entre versões do discord.js/@discordjs/builders:
  // algumas expõem addComponents() e outras spliceComponents().
  if (typeof builder.addComponents === 'function') {
    builder.addComponents(...components);
    return modal;
  }

  if (typeof builder.spliceComponents === 'function') {
    builder.spliceComponents(0, 0, ...components);
    return modal;
  }

  throw new Error('Sua versão do discord.js não possui suporte compatível a modais. Rode npm.cmd install e reinicie o bot.');
}

function positiveInt(raw: string, label: string, optional = false): number | null {
  const value = raw.trim();
  if (!value && optional) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${label} deve ser um número inteiro maior que zero.`);
  return Number(value);
}

function discordUserId(raw: string): string | null {
  const match = raw.trim().match(/^(?:<@!?)?(\d{15,25})>?$/);
  return match?.[1] ?? null;
}

async function findRaffleForEdit(guildId: string, rawRef: string) {
  const ref = rawRef.trim();
  if (!ref) throw new Error('Informe o ID ou nome da rifa.');

  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref);
  let query = supabase.from('raffles').select('*').eq('guild_id', guildId).is('deleted_at', null);
  query = uuidLike ? query.eq('id', ref) : query.ilike('name', ref);

  const { data, error } = await query.limit(2);
  if (error) throw error;
  if (!data?.length) throw new Error('Rifa não encontrada. Confira o ID ou o nome exato.');
  if (data.length > 1) throw new Error('Existe mais de uma rifa com esse nome. Use o ID da rifa.');
  return data[0] as any;
}

async function saveRaffleEdit(
  client: Client,
  key: string,
  actorId: string,
  extraChanges: Record<string, any> = {}
) {
  const draft = raffleEditDrafts.get(key);
  if (!draft) throw new Error('A edição expirou. Use /editar-rifa novamente.');

  const updates = { ...draft.changes, ...extraChanges, updated_at: new Date().toISOString() };
  const meaningfulKeys = Object.keys(updates).filter(k => k !== 'updated_at');
  if (!meaningfulKeys.length) throw new Error('Nenhuma alteração foi informada.');

  const { data, error } = await supabase
    .from('raffles')
    .update(updates)
    .eq('id', draft.raffleId)
    .eq('guild_id', draft.guildId)
    .in('status', ['active', 'paused'])
    .is('deleted_at', null)
    .select('*')
    .single();
  if (error) throw new Error('A rifa mudou de estado, foi encerrada/sorteada ou não pode mais ser editada. Abra /editar-rifa novamente.');

  raffleEditDrafts.delete(key);
  await audit(client, 'RIFA_EDITADA', actorId, {
    rifa_id: draft.raffleId,
    nome_anterior: draft.raffleName,
    nome_atual: data.name,
    descricao_atual: data.description,
    quantidade_numeros: data.number_count,
    valor_por_numero: data.number_price,
    foto_premio: data.image_url || 'não informada',
    limite_por_reserva: data.max_numbers_per_reservation,
    limite_por_usuario: data.max_numbers_per_user ?? 'sem limite',
    minutos_reserva: data.reservation_minutes,
    status: data.status,
    alteracoes: meaningfulKeys,
    editada_por: actorId
  }, actorId, 'raffle', draft.raffleId);
  await refreshRafflePanel(client, draft.raffleId);
  return data as any;
}

async function handleCommand(client: Client, interaction: ChatInputCommandInteraction) {
  const member = interaction.member as GuildMember;

  if (interaction.commandName === 'aviso') {
    if (!isAdmin(member)) return deny(interaction);

    const imageUpload = new FileUploadBuilder({
      custom_id: 'notice_image',
      min_values: 0,
      max_values: 1,
      required: false,
      file_types: ['image']
    });

    const imageLabel = new LabelBuilder()
      .setLabel('Imagem do aviso (opcional)')
      .setDescription('Envie PNG, JPG, WEBP ou GIF. Máx. 20 MB.')
      .setFileUploadComponent(imageUpload);

    const modal = new ModalBuilder()
      .setCustomId('cmd:notice')
      .setTitle('Enviar aviso');

    addModalComponents(modal,
      input('title', 'Título do aviso (opcional)', {
        required: false,
        placeholder: 'Ex.: 📢 Aviso importante',
        maxLength: 256
      }),
      input('text', 'Texto do aviso', {
        paragraph: true,
        placeholder: 'Digite aqui o aviso que o bot vai publicar...',
        maxLength: 4000
      }),
      imageLabel
    );

    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'status-bot') {
    const { error } = await supabase.from('profiles').select('id', { head: true, count: 'exact' });
    return interaction.reply({ content: error ? `⚠️ Discord OK, Supabase com erro: ${error.message}` : '✅ Discord conectado e Supabase respondendo.', flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === 'publicar-verificacao') {
    if (!isAdmin(member)) return deny(interaction);
    const channel = await client.channels.fetch(getCachedSettings(interaction.guildId!).verification_channel_id).catch(() => null);
    if (!channel?.isTextBased() || !channel.isSendable()) return interaction.reply({ content: '❌ VERIFICATION_CHANNEL_ID inválido ou sem suporte para envio de mensagens.', flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder()
      .setTitle('✅ Verificação de Conta')
      .setDescription(
        'Clique no botão abaixo e informe seu **nome no Legacy** e seu **ID**.\n\n' +
        '⚠️ O ID informado não poderá ser utilizado por outra conta.\n\n' +
        'Após enviar, sua solicitação será encaminhada para análise de um **Dono ou ADM**.\n\n' +
        'Quando for aprovado, o bot vai remover o cargo **Membro não verificado**, adicionar **Membro verificado** e alterar seu apelido para:\n**Nome | ID**'
      );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('verify:start').setLabel('Verificar conta').setEmoji('✅').setStyle(ButtonStyle.Success)
    );
    await channel.send({ embeds: [embed], components: [row] });
    return interaction.reply({ content: '✅ Painel de verificação publicado.', flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === 'criar-rifa') {
    if (!isAdmin(member)) return deny(interaction);

    const prizeUpload = new FileUploadBuilder({
      custom_id: 'prize_image',
      min_values: 1,
      max_values: 1,
      required: true,
      file_types: ['image']
    });

    const prizeLabel = new LabelBuilder()
      .setLabel('Foto do prêmio')
      .setDescription('Envie 1 imagem PNG, JPG, WEBP ou GIF (máx. 20 MB).')
      .setFileUploadComponent(prizeUpload);

    // O /criar-rifa deve abrir o modal imediatamente. Usamos addComponents aqui
    // porque ele é compatível com a versão do builder usada pelo discord.js 14.27.x.
    // A versão anterior usava modal.spliceComponents(), que podia gerar
    // "modal.spliceComponents is not a function" em instalações existentes.
    const modal = new ModalBuilder().setCustomId('cmd:create-raffle:step1').setTitle('Criar rifa — Etapa 1/2');
    addModalComponents(modal,
      input('name', 'Nome da rifa', { maxLength: 100 }),
      input('description', 'Descrição', { paragraph: true, maxLength: 1000 }),
      input('quantity', 'Quantidade total de números', { placeholder: 'Ex.: 100', maxLength: 6 }),
      input('price', 'Valor de cada número no jogo', { placeholder: 'Ex.: 50000', maxLength: 12 }),
      prizeLabel
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'editar-rifa') {
    if (!isAdmin(member)) return deny(interaction);

    const prizeUpload = new FileUploadBuilder({
      custom_id: 'edit_prize_image',
      min_values: 0,
      max_values: 1,
      required: false,
      file_types: ['image']
    });

    const prizeLabel = new LabelBuilder()
      .setLabel('Nova foto do prêmio (opcional)')
      .setDescription('Deixe vazio para manter a foto atual.')
      .setFileUploadComponent(prizeUpload);

    const modal = new ModalBuilder().setCustomId('cmd:edit-raffle:step1').setTitle('Editar rifa — Etapa 1/2');
    addModalComponents(modal,
      input('raffle_ref', 'ID ou nome exato da rifa', { placeholder: 'Cole o ID ou escreva o nome', maxLength: 100 }),
      input('name', 'Novo nome (opcional)', { required: false, placeholder: 'Vazio = manter atual', maxLength: 100 }),
      input('description', 'Nova descrição (opcional)', { required: false, paragraph: true, placeholder: 'Vazio = manter atual', maxLength: 1000 }),
      input('price', 'Novo valor por número (opcional)', { required: false, placeholder: 'Vazio = manter atual', maxLength: 12 }),
      prizeLabel
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'publicar-rifa') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:publish-raffle').setTitle('Publicar rifa');
    addModalComponents(modal,
      input('raffle_id', 'ID da rifa', { placeholder: 'Cole o UUID da rifa', maxLength: 80 }),
      input('channel_id', 'ID do canal (opcional)', { required: false, placeholder: 'Vazio = canal configurado / atual', maxLength: 30 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'criar-cupom') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:create-coupon:step1').setTitle('Criar cupom — Etapa 1/2');
    addModalComponents(modal,
      input('code', 'Código do cupom', { placeholder: 'Ex.: VIP20', maxLength: 30, minLength: 2 }),
      input('discount', 'Desconto em %', { placeholder: 'Ex.: 20', maxLength: 3 }),
      input('min_numbers', 'Quantidade mínima de números', { placeholder: 'Ex.: 10', maxLength: 6 }),
      input('max_uses', 'Limite total de usos', { placeholder: 'Ex.: 30', maxLength: 8 }),
      input('per_user', 'Limite de usos por usuário', { placeholder: 'Ex.: 1', maxLength: 6 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'desativar-cupom') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:disable-coupon').setTitle('Desativar cupom');
    addModalComponents(modal,input('code', 'Código do cupom', { placeholder: 'Ex.: VIP20', maxLength: 30 }));
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'editar-cupom') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:edit-coupon').setTitle('Editar cupom');
    addModalComponents(modal,
      input('code', 'Código do cupom', { placeholder: 'Ex.: VIP20', maxLength: 30 }),
      input('discount', 'Novo desconto % (opcional)', { required: false, placeholder: 'Vazio = não alterar', maxLength: 3 }),
      input('min_numbers', 'Novo mínimo números (opcional)', { required: false, placeholder: 'Vazio = não alterar', maxLength: 6 }),
      input('max_uses', 'Novo limite total (opcional)', { required: false, placeholder: 'Vazio = não alterar', maxLength: 8 }),
      input('per_user', 'Novo limite por usuário (opcional)', { required: false, placeholder: 'Vazio = não alterar', maxLength: 6 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'excluir-cupom') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:delete-coupon').setTitle('Excluir cupom');
    addModalComponents(modal,input('code', 'Código do cupom', { placeholder: 'Ex.: VIP20', maxLength: 30 }));
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'cupom-usos') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:coupon-uses').setTitle('Consultar usos do cupom');
    addModalComponents(modal,input('code', 'Código do cupom', { placeholder: 'Ex.: VIP20', maxLength: 30 }));
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'ranking') {
    const modal = new ModalBuilder().setCustomId('cmd:ranking').setTitle('Ranking de compradores');
    addModalComponents(modal,input('raffle_id', 'ID da rifa (opcional)', { required: false, placeholder: 'Vazio = ranking geral', maxLength: 80 }));
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'sortear') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:draw').setTitle('Realizar sorteio');
    addModalComponents(modal,input('raffle_id', 'ID da rifa', { placeholder: 'Cole o UUID da rifa', maxLength: 80 }));
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'republicar-resultado') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:republish-result').setTitle('Republicar resultado');
    addModalComponents(modal,input('raffle_id', 'ID da rifa', { placeholder: 'Cole o UUID da rifa já sorteada', maxLength: 80 }));
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'punir') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:punish').setTitle('Aplicar punição');
    addModalComponents(modal,
      input('user', 'ID ou menção do usuário', { placeholder: 'Ex.: 123... ou @Usuário', maxLength: 40 }),
      input('duration', 'Duração', { placeholder: '30m, 1h, 6h, 24h, 7d ou permanente', maxLength: 20 }),
      input('reason', 'Motivo', { paragraph: true, maxLength: 500 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'remover-punicao') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:unpunish').setTitle('Remover punição');
    addModalComponents(modal,
      input('user', 'ID ou menção do usuário', { placeholder: 'Ex.: 123... ou @Usuário', maxLength: 40 }),
      input('reason', 'Motivo da remoção', { paragraph: true, maxLength: 500 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'gerenciar-rifa') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:manage-raffle').setTitle('Gerenciar rifa');
    addModalComponents(modal,
      input('raffle_ref', 'ID ou nome exato da rifa', { placeholder: 'ID ou nome da rifa', maxLength: 100 }),
      input('action', 'Ação', { placeholder: 'pausar, reativar, encerrar ou excluir', maxLength: 20 }),
      input('reason', 'Motivo (opcional)', { required: false, paragraph: true, placeholder: 'Ex.: rifa cancelada pela equipe', maxLength: 500 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'numeros-rifa') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:raffle-numbers').setTitle('Consultar números da rifa');
    addModalComponents(modal,
      input('raffle_ref', 'ID ou nome exato da rifa', { placeholder: 'ID ou nome da rifa', maxLength: 100 }),
      input('filter', 'Filtro', { required: false, placeholder: 'todos, disponivel, reservado ou vendido', maxLength: 20 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'ativar-cupom') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:enable-coupon').setTitle('Ativar cupom');
    addModalComponents(modal, input('code', 'Código do cupom', { placeholder: 'Ex.: VIP20', maxLength: 30 }));
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'historico-punicoes') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId('cmd:punishment-history').setTitle('Histórico de punições');
    addModalComponents(modal, input('user', 'ID ou menção do usuário', { placeholder: 'Ex.: 123... ou @Usuário', maxLength: 40 }));
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'perfil') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { data: profile } = await supabase.from('profiles').select('*').eq('discord_id', interaction.user.id).maybeSingle();
    if (!profile?.verified) return interaction.editReply('❌ Você ainda não possui uma conta verificada.');
    const [{ data: sold }, { data: wins }, { data: allSold }] = await Promise.all([
      supabase.from('raffle_numbers').select('raffle_id').eq('status', 'sold').eq('sold_to', interaction.user.id),
      supabase.from('raffle_results').select('id').eq('winner_discord_id', interaction.user.id),
      supabase.from('raffle_numbers').select('sold_to').eq('status', 'sold').not('sold_to', 'is', null)
    ]);
    const counts = new Map<string, number>();
    for (const row of allSold ?? []) counts.set(row.sold_to!, (counts.get(row.sold_to!) ?? 0) + 1);
    const ranking = [...counts.entries()].sort((a,b)=>b[1]-a[1]);
    const position = ranking.findIndex(([id])=>id===interaction.user.id) + 1;
    const rafflesJoined = new Set((sold ?? []).map((x:any)=>x.raffle_id)).size;
    const blocked = profile.blocked_until && new Date(profile.blocked_until).getTime() > Date.now();
    const embed = new EmbedBuilder().setTitle('👤 Seu perfil — LGC Win').addFields(
      { name: 'Legacy', value: `**${profile.mta_name} | ${profile.mta_id}**`, inline: false },
      { name: '🎟️ Rifas participadas', value: String(rafflesJoined), inline: true },
      { name: '🔢 Números comprados', value: String(sold?.length ?? 0), inline: true },
      { name: '🏆 Rifas ganhas', value: String(wins?.length ?? 0), inline: true },
      { name: '🥇 Posição geral', value: position > 0 ? `#${position}` : 'Sem posição', inline: true },
      { name: '🚫 Bloqueio', value: blocked ? `Até <t:${Math.floor(new Date(profile.blocked_until).getTime()/1000)}:F>` : 'Nenhum', inline: false }
    ).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (interaction.commandName === 'painel') {
    if (!isAdmin(member)) return deny(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [raffles, purchases, coupons, verified, blocked] = await Promise.all([
      supabase.from('raffles').select('id,status', { count: 'exact' }).is('deleted_at', null),
      supabase.from('purchases').select('id,status', { count: 'exact' }).in('status', ['pending','in_review']),
      supabase.from('coupons').select('id', { count: 'exact' }).eq('active', true).is('deleted_at', null),
      supabase.from('profiles').select('id', { count: 'exact' }).eq('verified', true),
      supabase.from('profiles').select('id,blocked_until').not('blocked_until','is',null)
    ]);
    const activeRaffles = (raffles.data ?? []).filter((x:any)=>['active','paused','closed'].includes(x.status)).length;
    const activeBlocked = (blocked.data ?? []).filter((x:any)=>new Date(x.blocked_until).getTime() > Date.now()).length;
    const embed = new EmbedBuilder().setTitle('⚙️ Painel Administrativo — LGC Win').addFields(
      { name: '🎟️ Rifas abertas/gerenciáveis', value: String(activeRaffles), inline: true },
      { name: '💰 Compras pendentes', value: String(purchases.count ?? purchases.data?.length ?? 0), inline: true },
      { name: '🎫 Cupons ativos', value: String(coupons.count ?? coupons.data?.length ?? 0), inline: true },
      { name: '✅ Usuários verificados', value: String(verified.count ?? verified.data?.length ?? 0), inline: true },
      { name: '🚫 Usuários bloqueados', value: String(activeBlocked), inline: true },
      { name: '🧭 Atalhos', value: '`/criar-rifa` • `/editar-rifa` • `/gerenciar-rifa` • `/numeros-rifa` • `/criar-cupom` • `/sortear` • `/backup`' }
    ).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (interaction.commandName === 'configurar') {
    if (!isOwner(member)) return deny(interaction, '❌ Apenas o Dono pode alterar a configuração do bot.');
    const st = getCachedSettings(interaction.guildId!);
    const modal = new ModalBuilder().setCustomId('cmd:config:step1').setTitle('Configurar bot — Etapa 1/3');
    addModalComponents(modal,
      input('raffle_channel', 'Canal público de rifas', { required: false, value: st.raffle_channel_id ?? '', placeholder: 'ID do canal', maxLength: 30 }),
      input('verification_channel', 'Canal público de verificação', { value: st.verification_channel_id, maxLength: 30 }),
      input('verification_log_channel', 'Canal log de verificação', { value: st.verification_log_channel_id, maxLength: 30 }),
      input('purchase_log_channel', 'Canal log de compras', { value: st.purchase_log_channel_id, maxLength: 30 }),
      input('results_channel', 'Canal de resultados', { value: st.results_channel_id, maxLength: 30 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'backup') {
    if (!isOwner(member)) return deny(interaction, '❌ Apenas o Dono pode gerar backup.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const tables = ['app_meta','profiles','verification_requests','raffles','raffle_numbers','purchases','purchase_numbers','coupons','punishments','raffle_results','audit_logs','guild_settings'];
    const backup: Record<string, unknown> = {
      backup_version: '1.1.4',
      generated_at: new Date().toISOString(),
      guild_id: interaction.guildId,
      validated: false,
      table_counts: {}
    };
    const counts: Record<string, number> = {};
    try {
      for (const table of tables) {
        const { rows, count } = await fetchAllTableRows(table);
        backup[table] = rows;
        counts[table] = count;
      }
      backup.table_counts = counts;
      backup.validated = true;
      const json = Buffer.from(JSON.stringify(backup, null, 2), 'utf8');
      const compressed = gzipSync(json, { level: 9 });
      const file = new AttachmentBuilder(compressed, { name: `LGC-Win-backup-v1.1.4-${new Date().toISOString().slice(0,10)}.json.gz` });
      await audit(client, 'BACKUP_GERADO', interaction.user.id, { tabelas: tables.length, linhas: Object.values(counts).reduce((a,b)=>a+b,0), bytes_json: json.length, bytes_gzip: compressed.length });
      return interaction.editReply({ content: '✅ Backup completo e validado por contagem de linhas. O arquivo está compactado em **.json.gz**; guarde-o fora da host.', files: [file] });
    } catch (e) {
      console.error('Falha no backup:', e);
      return interaction.editReply(`❌ O backup foi cancelado para não entregar arquivo incompleto: ${errMessage(e)}`);
    }
  }

  if (interaction.commandName === 'minhas-compras') {
    const { data, error } = await supabase.from('purchases').select('id,status,total,created_at,raffles(name),purchase_numbers(number)').eq('discord_id', interaction.user.id).order('created_at', { ascending: false }).limit(10);
    if (error) return interaction.reply({ content: `❌ ${errMessage(error)}`, flags: MessageFlags.Ephemeral });
    if (!data?.length) return interaction.reply({ content: 'Você ainda não possui compras.', flags: MessageFlags.Ephemeral });
    const lines = data.map((p:any)=>`**${p.raffles?.name ?? 'Rifa'}** — ${p.purchase_numbers?.map((n:any)=>n.number).join(', ') || '-'} — ${money(p.total)} — \`${p.status}\``);
    return interaction.reply({ content: `🧾 **Suas compras recentes**\n\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
  }
}

async function handleButton(client: Client, interaction: ButtonInteraction) {
  const member = interaction.member as GuildMember;

  if (interaction.customId === 'cmd:create-raffle-next') {
    if (!isAdmin(member)) return deny(interaction);
    const key = draftKey(interaction.guildId, interaction.user.id);
    const draft = raffleDrafts.get(key);
    if (!draft) return deny(interaction, '❌ O formulário anterior expirou. Use /criar-rifa novamente.');
    const modal = new ModalBuilder().setCustomId('cmd:create-raffle:step2').setTitle('Criar rifa — Etapa 2/2');
    addModalComponents(modal,
      input('max_reservation', 'Máximo por reserva', { placeholder: 'Ex.: 10', value: '10', maxLength: 6 }),
      input('max_user', 'Máximo total por usuário (opcional)', { required: false, placeholder: 'Vazio = sem limite', maxLength: 6 }),
      input('reservation_minutes', 'Minutos da reserva', { placeholder: 'Ex.: 10', value: String(getCachedSettings(interaction.guildId!).default_reservation_minutes), maxLength: 4 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'cmd:edit-raffle-save') {
    if (!isAdmin(member)) return deny(interaction);
    const key = draftKey(interaction.guildId, interaction.user.id);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const raffle = await saveRaffleEdit(client, key, interaction.user.id);
      return interaction.editReply(`✅ Rifa **${raffle.name}** atualizada. O painel publicado também foi atualizado.`);
    } catch (e) {
      return interaction.editReply(`❌ ${errMessage(e)}`);
    }
  }

  if (interaction.customId === 'cmd:edit-raffle-limits') {
    if (!isAdmin(member)) return deny(interaction);
    const key = draftKey(interaction.guildId, interaction.user.id);
    const draft = raffleEditDrafts.get(key);
    if (!draft) return deny(interaction, '❌ A edição expirou. Use /editar-rifa novamente.');

    const modal = new ModalBuilder().setCustomId('cmd:edit-raffle:step2').setTitle('Editar rifa — Etapa 2/2');
    addModalComponents(modal,
      input('max_reservation', 'Máximo por reserva', { required: false, value: String(draft.current.maxNumbersPerReservation), maxLength: 6 }),
      input('max_user', 'Máximo por usuário (0 = sem limite)', { required: false, value: draft.current.maxNumbersPerUser == null ? '0' : String(draft.current.maxNumbersPerUser), maxLength: 6 }),
      input('reservation_minutes', 'Minutos da reserva', { required: false, value: String(draft.current.reservationMinutes), maxLength: 4 }),
      input('status', 'Status: active ou paused', { required: false, value: draft.current.status === 'paused' ? 'paused' : 'active', maxLength: 10 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'cmd:create-coupon-next') {
    if (!isAdmin(member)) return deny(interaction);
    const key = draftKey(interaction.guildId, interaction.user.id);
    const draft = couponDrafts.get(key);
    if (!draft) return deny(interaction, '❌ O formulário anterior expirou. Use /criar-cupom novamente.');
    const modal = new ModalBuilder().setCustomId('cmd:create-coupon:step2').setTitle('Criar cupom — Etapa 2/2');
    addModalComponents(modal,
      input('name', 'Nome do cupom', { placeholder: 'Ex.: Desconto VIP', maxLength: 80 }),
      input('raffle_id', 'ID da rifa (opcional)', { required: false, placeholder: 'Vazio = cupom global', maxLength: 80 }),
      input('valid_days', 'Validade em dias (opcional)', { required: false, placeholder: 'Vazio = sem validade', maxLength: 6 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'cmd:config-next2') {
    if (!isOwner(member)) return deny(interaction, '❌ Apenas o Dono pode configurar o bot.');
    const key = draftKey(interaction.guildId, interaction.user.id);
    if (!configDrafts.has(key)) return deny(interaction, '❌ A configuração expirou. Use /configurar novamente.');
    const st = getCachedSettings(interaction.guildId!);
    const modal = new ModalBuilder().setCustomId('cmd:config:step2').setTitle('Configurar bot — Etapa 2/3');
    addModalComponents(modal,
      input('audit_channel', 'Canal de logs gerais', { value: st.audit_channel_id, maxLength: 30 }),
      input('owner_role', 'Cargo Dono', { value: st.owner_role_id, maxLength: 30 }),
      input('admin_role', 'Cargo ADM', { value: st.admin_role_id, maxLength: 30 }),
      input('unverified_role', 'Cargo Membro não verificado', { value: st.unverified_role_id, maxLength: 30 }),
      input('verified_role', 'Cargo Membro verificado', { value: st.verified_role_id, maxLength: 30 })
    );
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'cmd:config-next3') {
    if (!isOwner(member)) return deny(interaction, '❌ Apenas o Dono pode configurar o bot.');
    const key = draftKey(interaction.guildId, interaction.user.id);
    if (!configDrafts.has(key)) return deny(interaction, '❌ A configuração expirou. Use /configurar novamente.');
    const st = getCachedSettings(interaction.guildId!);
    const modal = new ModalBuilder().setCustomId('cmd:config:step3').setTitle('Configurar bot — Etapa 3/3');
    addModalComponents(modal,
      input('reservation_minutes', 'Tempo padrão da reserva (min)', { value: String(st.default_reservation_minutes), maxLength: 4 }),
      input('review_minutes', 'Tempo da análise do ADM (min)', { value: String(st.default_review_minutes), maxLength: 4 })
    );
    return interaction.showModal(modal);
  }

  const [action, id] = interaction.customId.split(':');

  if (interaction.customId === 'verify:start') {
    try {
      const state = await syncMemberVerificationState(member, 'Sincronização ao iniciar verificação');
      if (state.verified) return deny(interaction, '✅ Sua conta já está verificada.');
    } catch (error) {
      console.error('Erro ao sincronizar cargo antes da verificação:', error);
      return deny(interaction, '❌ Não consegui validar seus cargos agora. Tente novamente em alguns segundos.');
    }
    const accountDays = (Date.now() - interaction.user.createdTimestamp) / 86400000;
    const joinedMinutes = member.joinedTimestamp ? (Date.now() - member.joinedTimestamp) / 60000 : 0;
    if (config.MIN_DISCORD_ACCOUNT_DAYS > 0 && accountDays < config.MIN_DISCORD_ACCOUNT_DAYS) {
      return deny(interaction, `❌ Sua conta do Discord precisa ter pelo menos ${config.MIN_DISCORD_ACCOUNT_DAYS} dias para solicitar verificação.`);
    }
    if (config.MIN_SERVER_MINUTES > 0 && joinedMinutes < config.MIN_SERVER_MINUTES) {
      return deny(interaction, `❌ Você precisa estar no servidor há pelo menos ${config.MIN_SERVER_MINUTES} minuto(s) para solicitar verificação.`);
    }
    const modal = new ModalBuilder().setCustomId('verify:modal').setTitle('Verificar conta Legacy');
    const name = new TextInputBuilder().setCustomId('mta_name').setLabel('Nome no Legacy').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(2).setMaxLength(40);
    const mtaId = new TextInputBuilder().setCustomId('mta_id').setLabel('ID no Legacy').setPlaceholder('Ex.: 123').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10);
    addModalComponents(modal,new ActionRowBuilder<TextInputBuilder>().addComponents(name), new ActionRowBuilder<TextInputBuilder>().addComponents(mtaId));
    return interaction.showModal(modal);
  }

  if (action === 'buy') {
    const eligibilityError = await purchaseEligibilityError(interaction);
    if (eligibilityError) return deny(interaction, eligibilityError);
    return showNumberPicker(interaction, id, 0);
  }

  if (interaction.customId.startsWith('numbers:view:')) {
    const [, , raffleId, rawPage] = interaction.customId.split(':');
    return showNumberPicker(interaction, raffleId, Number(rawPage) || 0);
  }

  if (action === 'rank') {
    const { data } = await supabase.from('raffle_numbers').select('sold_to').eq('raffle_id', id).eq('status','sold').not('sold_to','is',null);
    const counts = new Map<string,number>();
    for (const x of data ?? []) counts.set(x.sold_to!, (counts.get(x.sold_to!)??0)+1);
    const top=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
    if (!top.length) return interaction.reply({ content:'🏆 Ainda não há compradores aprovados nesta rifa.', flags: MessageFlags.Ephemeral });
    const { data: profiles } = await supabase.from('profiles').select('discord_id,mta_name,mta_id').in('discord_id',top.map(x=>x[0]));
    const pm=new Map<string, any>((profiles??[]).map((p:any)=>[p.discord_id,p]));
    return interaction.reply({ content:`🏆 **Ranking da rifa**\n\n${top.map(([uid,c],i)=>`${i+1}º **${pm.get(uid)?.mta_name??'Jogador'} | ${pm.get(uid)?.mta_id??'?'}** — ${c}`).join('\n')}`, flags: MessageFlags.Ephemeral });
  }

  if (action === 'verifyapprove') {
    if (!isAdmin(member)) return deny(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { data: profile, error } = await supabase.rpc('approve_verification', { p_request_id: id, p_admin_id: interaction.user.id });
    if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
    const profileRow = rpcOne<any>(profile);
    if (!profileRow) return interaction.editReply('❌ O banco não retornou o perfil aprovado.');
    const guildMember = await interaction.guild!.members.fetch(profileRow.discord_id).catch(()=>null);
    const targetNickname = `${profileRow.mta_name} | ${profileRow.mta_id}`.slice(0, 32);
    let roleApplied = false;
    let nicknameApplied = false;
    let nicknameError = '';

    if (guildMember) {
      try {
        await applyVerificationRoles(guildMember, true, `Verificação aprovada por ${interaction.user.tag}`);
        roleApplied = true;
      } catch (error) {
        console.error('Erro ao trocar cargos de verificação:', error);
      }

      // O Discord só permite alterar o apelido de membros que o cargo do bot consegue gerenciar.
      // Isso também evita um erro 50013 (Missing Permissions) quando a pessoa é o dono do servidor
      // ou possui um cargo igual/acima do cargo do bot.
      if (!guildMember.manageable) {
        nicknameError = guildMember.id === guildMember.guild.ownerId
          ? 'Essa conta é o dono do servidor e o Discord não permite que bots alterem o apelido do proprietário.'
          : 'O cargo do bot não está acima do cargo mais alto deste membro, ou o bot não possui Gerenciar Apelidos.';
        console.warn(`⚠️ Apelido não alterado para ${guildMember.user.tag}: ${nicknameError}`);
      } else {
        try {
          await guildMember.setNickname(targetNickname, `Verificação aprovada por ${interaction.user.tag}`);
          nicknameApplied = true;
        } catch (error: any) {
          console.error('Erro ao alterar apelido após verificação:', error);
          nicknameError = error?.message || 'O Discord bloqueou a alteração do apelido.';
        }
      }

      const dmStatus = nicknameApplied
        ? `✅ Sua verificação foi aprovada. Seu apelido no servidor agora é **${targetNickname}**.`
        : `✅ Sua verificação foi aprovada. Não consegui alterar seu apelido automaticamente; um ADM pode ajustar para **${targetNickname}**.`;
      await guildMember.send(dmStatus).catch(()=>null);
    }
    const approvedEmbed = new EmbedBuilder()
      .setTitle('✅ Verificação aprovada')
      .addFields(
        { name:'Discord', value:`<@${profileRow.discord_id}> (${profileRow.discord_id})` },
        { name:'Nome Legacy', value:String(profileRow.mta_name), inline:true },
        { name:'ID Legacy', value:String(profileRow.mta_id), inline:true },
        { name:'Status', value:`✅ Aprovado por <@${interaction.user.id}>` }
      )
      .setFooter({ text:`Verificação ID: ${id}` })
      .setTimestamp();
    await interaction.message.edit({ embeds:[approvedEmbed], components: [] }).catch(()=>null);
    if (!guildMember) {
      return interaction.editReply(`✅ Verificação aprovada, mas não encontrei <@${profileRow.discord_id}> no servidor para aplicar cargo/apelido.`);
    }

    if (!nicknameApplied) {
      return interaction.editReply(
        `⚠️ Verificação aprovada para <@${profileRow.discord_id}>, mas o Discord não deixou o bot alterar o apelido para **${targetNickname}**.\n` +
        `Coloque o cargo **LGC Win** acima do cargo mais alto dessa pessoa e mantenha a permissão **Gerenciar apelidos**.\n` +
        `${roleApplied ? '✅ Cargos atualizados: Não Verificado removido e Verificado aplicado.' : '⚠️ Também não consegui trocar os cargos de verificação.'}\n` +
        `Detalhe: ${nicknameError}`
      );
    }

    return interaction.editReply(`✅ Verificação aprovada para <@${profileRow.discord_id}>. Cargo **Membro não verificado** removido, **Membro verificado** aplicado e apelido alterado para **${targetNickname}**.`);
  }

  if (action === 'verifyreject') {
    if (!isAdmin(member)) return deny(interaction);
    const modal = new ModalBuilder().setCustomId(`verifyrejectmodal:${id}`).setTitle('Recusar verificação');
    const reason = new TextInputBuilder().setCustomId('reason').setLabel('Motivo').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
    addModalComponents(modal,new ActionRowBuilder<TextInputBuilder>().addComponents(reason));
    return interaction.showModal(modal);
  }

  if (['claim','ownerclaim','approve','reject','release'].includes(action)) {
    if (!isAdmin(member)) return deny(interaction);
  }

  if (action === 'claim') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { error } = await supabase.rpc('claim_purchase', { p_purchase_id: id, p_admin_id: interaction.user.id, p_review_minutes: getCachedSettings(interaction.guildId!).default_review_minutes });
    if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
    await refreshPurchaseReviewMessage(client, id);
    return interaction.editReply('👮 Você assumiu esta análise. Agora somente você pode aprovar ou recusar.');
  }

  if (action === 'ownerclaim') {
    if (!isOwner(member)) return deny(interaction, '❌ Apenas o Dono pode forçar a transferência da análise.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { error } = await supabase.rpc('force_claim_purchase', { p_purchase_id: id, p_owner_id: interaction.user.id, p_review_minutes: getCachedSettings(interaction.guildId!).default_review_minutes });
    if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
    await refreshPurchaseReviewMessage(client, id);
    return interaction.editReply('👑 Você assumiu a análise como Dono.');
  }

  if (action === 'approve') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { data: purchase, error } = await supabase.rpc('approve_purchase', { p_purchase_id: id, p_admin_id: interaction.user.id });
    if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
    const purchaseRow = rpcOne<any>(purchase);
    if (!purchaseRow) return interaction.editReply('❌ O banco não retornou a compra aprovada.');
    await refreshPurchaseReviewMessage(client, id);
    await refreshRafflePanel(client, purchaseRow.raffle_id);
    const user = await client.users.fetch(purchaseRow.discord_id).catch(()=>null);
    await user?.send(`✅ Sua compra da rifa foi **aprovada**. Compra ID: \`${purchaseRow.id}\`.`).catch(()=>null);
    return interaction.editReply('✅ Compra aprovada e números marcados como vendidos.');
  }

  if (action === 'reject') {
    const { data: p } = await supabase.from('purchases').select('status,claimed_by').eq('id',id).single();
    if (!p || p.status!=='in_review' || p.claimed_by!==interaction.user.id) return deny(interaction,'❌ Somente o ADM que assumiu esta compra pode recusá-la.');
    const modal = new ModalBuilder().setCustomId(`purchaserejectmodal:${id}`).setTitle('Recusar compra');
    const reason = new TextInputBuilder().setCustomId('reason').setLabel('Motivo da recusa').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
    addModalComponents(modal,new ActionRowBuilder<TextInputBuilder>().addComponents(reason));
    return interaction.showModal(modal);
  }

  if (action === 'release') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { error } = await supabase.rpc('release_purchase_review', { p_purchase_id: id, p_admin_id: interaction.user.id, p_force: isOwner(member) });
    if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
    await refreshPurchaseReviewMessage(client, id);
    return interaction.editReply('🔓 Análise liberada. Outro ADM pode assumir.');
  }
}

async function handleStringSelectMenu(client: Client, interaction: StringSelectMenuInteraction) {
  if (!interaction.customId.startsWith('numbers:select:')) return;

  const [, , raffleId] = interaction.customId.split(':');
  const eligibilityError = await purchaseEligibilityError(interaction);
  if (eligibilityError) return deny(interaction, eligibilityError);

  const selected = Array.from(new Set(interaction.values.map((value: string) => Number(value))));
  if (!selected.length || selected.some(number => !Number.isInteger(number) || number < 1)) {
    return deny(interaction, '❌ Selecione pelo menos um número válido.');
  }

  return showPurchaseModalFromNumbers(interaction, raffleId, selected.map(String));
}

async function handleModal(client: Client, interaction: ModalSubmitInteraction) {
  const member = interaction.member as GuildMember;

  if (interaction.customId === 'cmd:notice') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);

    try {
      const title = interaction.fields.getTextInputValue('title').trim();
      const text = interaction.fields.getTextInputValue('text').trim();
      if (!text) {
        return interaction.reply({ content: '❌ O texto do aviso não pode ficar vazio.', flags: MessageFlags.Ephemeral });
      }

      const channel = interaction.channel;
      if (!channel?.isTextBased() || !channel.isSendable()) {
        return interaction.reply({ content: '❌ Este canal não permite que o bot publique o aviso.', flags: MessageFlags.Ephemeral });
      }

      let imageUrl = '';
      try {
        const imageFile = interaction.fields.getUploadedFiles('notice_image', false)?.first() ?? null;
        if (imageFile) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          imageUrl = await uploadPrizeImage(imageFile, interaction.guildId!, interaction.user.id);
        }
      } catch (e) {
        if (interaction.deferred || interaction.replied) {
          return interaction.editReply(`❌ ${errMessage(e)}`);
        }
        return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
      }

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setTitle(title || '📢 Aviso')
        .setDescription(text)
        .setTimestamp();

      if (imageUrl) embed.setImage(imageUrl);

      await channel.send({ embeds: [embed] });
      await audit(client, 'AVISO_ENVIADO', interaction.user.id, {
        canal_id: channel.id,
        titulo: title || '📢 Aviso',
        descricao: text,
        imagem_url: imageUrl,
        com_imagem: Boolean(imageUrl)
      }, interaction.user.id, 'notice', channel.id);

      return interaction.editReply('✅ Aviso enviado neste canal.');
    } catch (e) {
      if (interaction.deferred || interaction.replied) return interaction.editReply(`❌ ${errMessage(e)}`);
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }
  if (interaction.customId === 'cmd:create-raffle:step1') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    try {
      const name = interaction.fields.getTextInputValue('name').trim();
      const description = interaction.fields.getTextInputValue('description').trim();
      const numberCount = positiveInt(interaction.fields.getTextInputValue('quantity'), 'Quantidade')!;
      const numberPrice = positiveInt(interaction.fields.getTextInputValue('price'), 'Valor')!;
      const files = interaction.fields.getUploadedFiles('prize_image', true);
      const prizeImage = files.first();
      if (!prizeImage) return interaction.reply({ content: '❌ Envie a foto do prêmio.', flags: MessageFlags.Ephemeral });
      if (numberCount > 10000) return interaction.reply({ content: '❌ A quantidade máxima é 10.000 números.', flags: MessageFlags.Ephemeral });

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const imageUrl = await uploadPrizeImage(prizeImage, interaction.guildId!, interaction.user.id);
      const key = draftKey(interaction.guildId, interaction.user.id);
      raffleDrafts.set(key, { guildId: interaction.guildId!, userId: interaction.user.id, name, description, imageUrl, numberCount, numberPrice });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('cmd:create-raffle-next').setLabel('Continuar configuração').setEmoji('➡️').setStyle(ButtonStyle.Primary)
      );
      return interaction.editReply({ content: '✅ Etapa 1 salva e a foto do prêmio foi enviada. Clique abaixo para configurar os limites da rifa.', components: [row] });
    } catch (e) {
      if (interaction.deferred || interaction.replied) return interaction.editReply(`❌ ${errMessage(e)}`);
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId === 'cmd:create-raffle:step2') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const key = draftKey(interaction.guildId, interaction.user.id);
    const draft = raffleDrafts.get(key);
    if (!draft) return interaction.reply({ content: '❌ O formulário anterior expirou. Use /criar-rifa novamente.', flags: MessageFlags.Ephemeral });
    try {
      const maxReservation = positiveInt(interaction.fields.getTextInputValue('max_reservation'), 'Máximo por reserva')!;
      const maxUser = positiveInt(interaction.fields.getTextInputValue('max_user'), 'Máximo por usuário', true);
      const reservationMinutes = positiveInt(interaction.fields.getTextInputValue('reservation_minutes'), 'Minutos da reserva')!;
      if (maxReservation > 1000) return interaction.reply({ content: '❌ O máximo por reserva não pode passar de 1.000.', flags: MessageFlags.Ephemeral });
      if (maxUser != null && maxUser > 10000) return interaction.reply({ content: '❌ O máximo por usuário não pode passar de 10.000.', flags: MessageFlags.Ephemeral });
      if (reservationMinutes > 120) return interaction.reply({ content: '❌ A reserva pode ter no máximo 120 minutos.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { data, error } = await supabase.rpc('create_raffle_with_numbers', {
        p_guild_id: draft.guildId,
        p_name: draft.name,
        p_description: draft.description,
        p_image_url: draft.imageUrl,
        p_number_count: draft.numberCount,
        p_number_price: draft.numberPrice,
        p_max_per_reservation: maxReservation,
        p_max_per_user: maxUser,
        p_reservation_minutes: reservationMinutes,
        p_created_by: interaction.user.id
      });
      if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
      const raffle = rpcOne<any>(data);
      if (!raffle) return interaction.editReply('❌ O banco não retornou a rifa criada.');
      raffleDrafts.delete(key);
      const creatorRole = isOwner(member) ? 'Dono' : 'ADM';
      const creatorName = member.displayName || member.user.globalName || member.user.username;
      await audit(client, 'RIFA_CRIADA', interaction.user.id, {
        rifa_id: raffle.id,
        nome: raffle.name,
        descricao: raffle.description,
        quantidade_numeros: raffle.number_count,
        valor_por_numero: raffle.number_price,
        foto_premio: raffle.image_url || 'não informada',
        limite_por_reserva: raffle.max_numbers_per_reservation,
        limite_por_usuario: raffle.max_numbers_per_user ?? 'sem limite',
        minutos_reserva: raffle.reservation_minutes,
        criada_por: `${creatorRole} | ${creatorName}`,
        criador_discord_id: interaction.user.id
      }, interaction.user.id, 'raffle', raffle.id);
      return interaction.editReply(`✅ Rifa **${raffle.name}** criada.\nID: \`${raffle.id}\`\nCriada por: **${creatorRole} | ${creatorName}**\nUse \`/publicar-rifa\` para publicar o painel.`);
    } catch (e) {
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId === 'cmd:edit-raffle:step1') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    try {
      const raffleRef = interaction.fields.getTextInputValue('raffle_ref').trim();
      const raffle = await findRaffleForEdit(interaction.guildId!, raffleRef);
      if (['drawn', 'cancelled', 'closed'].includes(raffle.status)) {
        return interaction.reply({ content: `❌ A rifa está com status **${raffle.status}** e não pode mais ser editada.`, flags: MessageFlags.Ephemeral });
      }

      const name = interaction.fields.getTextInputValue('name').trim();
      const description = interaction.fields.getTextInputValue('description').trim();
      const priceRaw = interaction.fields.getTextInputValue('price').trim();
      const changes: Record<string, any> = {};
      if (name) changes.name = name;
      if (description) changes.description = description;
      if (priceRaw) changes.number_price = positiveInt(priceRaw, 'Valor')!;

      let uploadedFile: any = null;
      try {
        uploadedFile = interaction.fields.getUploadedFiles('edit_prize_image', false)?.first() ?? null;
      } catch {
        uploadedFile = null;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (uploadedFile) {
        changes.image_url = await uploadPrizeImage(uploadedFile, interaction.guildId!, interaction.user.id);
      }

      const key = draftKey(interaction.guildId, interaction.user.id);
      raffleEditDrafts.set(key, {
        guildId: interaction.guildId!,
        userId: interaction.user.id,
        raffleId: raffle.id,
        raffleName: raffle.name,
        changes,
        current: {
          maxNumbersPerReservation: raffle.max_numbers_per_reservation,
          maxNumbersPerUser: raffle.max_numbers_per_user,
          reservationMinutes: raffle.reservation_minutes,
          status: raffle.status
        }
      });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('cmd:edit-raffle-save').setLabel('Salvar agora').setEmoji('💾').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cmd:edit-raffle-limits').setLabel('Editar limites').setEmoji('⚙️').setStyle(ButtonStyle.Primary)
      );

      const changed = Object.keys(changes).length
        ? Object.keys(changes).map(k => `• ${k}`).join('\n')
        : 'Nenhum dado principal alterado ainda.';
      return interaction.editReply({
        content: `✏️ Editando **${raffle.name}**.\n\n${changed}\n\nClique em **Salvar agora** ou em **Editar limites** para ajustar limites, tempo e status.`,
        components: [row]
      });
    } catch (e) {
      if (interaction.deferred || interaction.replied) return interaction.editReply(`❌ ${errMessage(e)}`);
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId === 'cmd:edit-raffle:step2') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const key = draftKey(interaction.guildId, interaction.user.id);
    if (!raffleEditDrafts.has(key)) return interaction.reply({ content: '❌ A edição expirou. Use /editar-rifa novamente.', flags: MessageFlags.Ephemeral });

    try {
      const extra: Record<string, any> = {};
      const maxReservationRaw = interaction.fields.getTextInputValue('max_reservation').trim();
      const maxUserRaw = interaction.fields.getTextInputValue('max_user').trim();
      const reservationRaw = interaction.fields.getTextInputValue('reservation_minutes').trim();
      const statusRaw = interaction.fields.getTextInputValue('status').trim().toLowerCase();

      if (maxReservationRaw) {
        const value = positiveInt(maxReservationRaw, 'Máximo por reserva')!;
        if (value > 1000) throw new Error('O máximo por reserva não pode passar de 1.000.');
        extra.max_numbers_per_reservation = value;
      }
      if (maxUserRaw) {
        if (maxUserRaw === '0') extra.max_numbers_per_user = null;
        else {
          const value = positiveInt(maxUserRaw, 'Máximo por usuário')!;
          if (value > 10000) throw new Error('O máximo por usuário não pode passar de 10.000.');
          extra.max_numbers_per_user = value;
        }
      }
      if (reservationRaw) {
        const value = positiveInt(reservationRaw, 'Minutos da reserva')!;
        if (value > 120) throw new Error('A reserva pode ter no máximo 120 minutos.');
        extra.reservation_minutes = value;
      }
      if (statusRaw) {
        if (!['active', 'paused'].includes(statusRaw)) throw new Error('Status deve ser active ou paused.');
        extra.status = statusRaw;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const raffle = await saveRaffleEdit(client, key, interaction.user.id, extra);
      return interaction.editReply(`✅ Rifa **${raffle.name}** atualizada com sucesso. O painel publicado também foi atualizado.`);
    } catch (e) {
      if (interaction.deferred || interaction.replied) return interaction.editReply(`❌ ${errMessage(e)}`);
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId === 'cmd:manage-raffle') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    try {
      const raffleRef = interaction.fields.getTextInputValue('raffle_ref').trim();
      const actionRaw = interaction.fields.getTextInputValue('action').trim().toLowerCase();
      const reason = interaction.fields.getTextInputValue('reason').trim();
      const actionMap: Record<string,string> = {
        'pausar':'pause', 'pause':'pause',
        'reativar':'reactivate', 'ativar':'reactivate', 'reactivate':'reactivate',
        'encerrar':'close', 'fechar':'close', 'close':'close',
        'excluir':'delete', 'deletar':'delete', 'delete':'delete'
      };
      const action = actionMap[actionRaw];
      if (!action) return interaction.reply({ content: '❌ Ação inválida. Use: **pausar**, **reativar**, **encerrar** ou **excluir**.', flags: MessageFlags.Ephemeral });
      const raffle = await findRaffleForEdit(interaction.guildId!, raffleRef);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { data, error } = await supabase.rpc('manage_raffle', {
        p_raffle_id: raffle.id,
        p_action: action,
        p_actor_id: interaction.user.id,
        p_reason: reason || null
      });
      if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
      const updated = rpcOne<any>(data);
      await refreshRafflePanel(client, raffle.id);
      await audit(client, 'RIFA_GERENCIADA', interaction.user.id, { rifa: raffle.name, acao: action, motivo: reason || 'não informado' }, null, 'raffle', raffle.id);
      return interaction.editReply(`✅ Rifa **${raffle.name}** atualizada. Novo status: **${updated?.status ?? 'atualizado'}**.`);
    } catch (e) {
      if (interaction.deferred || interaction.replied) return interaction.editReply(`❌ ${errMessage(e)}`);
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId === 'cmd:raffle-numbers') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const raffle = await findRaffleForEdit(interaction.guildId!, interaction.fields.getTextInputValue('raffle_ref').trim());
      const rawFilter = interaction.fields.getTextInputValue('filter').trim().toLowerCase();
      const filterMap: Record<string,string> = {
        '':'all','todos':'all','all':'all',
        'disponivel':'available','disponíveis':'available','disponiveis':'available','available':'available',
        'reservado':'reserved','reservados':'reserved','reserved':'reserved',
        'vendido':'sold','vendidos':'sold','sold':'sold'
      };
      const filter = filterMap[rawFilter];
      if (!filter) return interaction.editReply('❌ Filtro inválido. Use: todos, disponivel, reservado ou vendido.');
      let query = supabase.from('raffle_numbers').select('number,status,reserved_by,reserved_until,sold_to,purchase_id').eq('raffle_id', raffle.id).order('number');
      if (filter !== 'all') query = query.eq('status', filter);
      const { data: rows, error } = await query;
      if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
      const userIds = [...new Set((rows ?? []).flatMap((x:any)=>[x.reserved_by,x.sold_to]).filter(Boolean))];
      const purchaseIds = [...new Set((rows ?? []).map((x:any)=>x.purchase_id).filter(Boolean))];
      const [{ data: profiles }, { data: purchases }] = await Promise.all([
        userIds.length ? supabase.from('profiles').select('discord_id,mta_name,mta_id').in('discord_id', userIds) : Promise.resolve({ data: [] as any[] }),
        purchaseIds.length ? supabase.from('purchases').select('id,game_phone').in('id', purchaseIds) : Promise.resolve({ data: [] as any[] })
      ]);
      const pm = new Map<string,any>((profiles ?? []).map((x:any)=>[x.discord_id,x]));
      const phoneMap = new Map<string,string>((purchases ?? []).map((x:any)=>[x.id,x.game_phone]));
      const icon: Record<string,string> = { available:'🟢', reserved:'🟡', sold:'🔴' };
      const label: Record<string,string> = { available:'Disponível', reserved:'Reservado', sold:'Vendido' };
      const lines = (rows ?? []).map((x:any)=>{
        const uid = x.status === 'sold' ? x.sold_to : x.reserved_by;
        const pr = uid ? pm.get(uid) : null;
        const who = pr ? ` — ${pr.mta_name} | ${pr.mta_id}` : '';
        const phone = x.purchase_id && phoneMap.get(x.purchase_id) ? ` — Tel: ${phoneMap.get(x.purchase_id)}` : '';
        return `${icon[x.status] ?? '•'} #${x.number} — ${label[x.status] ?? x.status}${who}${phone}`;
      });
      const counts = { available: 0, reserved: 0, sold: 0 } as Record<string,number>;
      const { data: all } = await supabase.from('raffle_numbers').select('status').eq('raffle_id', raffle.id);
      for (const x of all ?? []) counts[x.status] = (counts[x.status] ?? 0) + 1;
      const header = `🎟️ **${raffle.name}**\n🟢 ${counts.available} disponíveis • 🟡 ${counts.reserved} reservados • 🔴 ${counts.sold} vendidos\nFiltro: **${filter === 'all' ? 'todos' : label[filter]}**`;
      const body = lines.join('\n') || 'Nenhum número encontrado com esse filtro.';
      if ((header.length + body.length) <= 1900) return interaction.editReply(`${header}\n\n${body}`);
      const file = new AttachmentBuilder(Buffer.from(`${header.replace(/\*\*/g,'')}\n\n${body}`, 'utf8'), { name: `numeros-${raffle.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.txt` });
      return interaction.editReply({ content: `${header}\n\nA lista completa está no arquivo abaixo.`, files: [file] });
    } catch (e) {
      if (interaction.deferred || interaction.replied) return interaction.editReply(`❌ ${errMessage(e)}`);
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId === 'cmd:enable-coupon') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const code = interaction.fields.getTextInputValue('code').trim().toUpperCase();
    const { data, error } = await supabase.from('coupons').update({ active: true, updated_at: new Date().toISOString() }).eq('code', code).is('deleted_at', null).select('id').maybeSingle();
    if (error || !data) return interaction.reply({ content: `❌ Cupom não encontrado ou erro: ${errMessage(error)}`, flags: MessageFlags.Ephemeral });
    await audit(client, 'CUPOM_ATIVADO', interaction.user.id, { codigo: code });
    return interaction.reply({ content: `✅ Cupom **${code}** ativado.`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'cmd:punishment-history') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const userId = discordUserId(interaction.fields.getTextInputValue('user'));
    if (!userId) return interaction.reply({ content: '❌ Informe o ID do Discord ou uma menção válida.', flags: MessageFlags.Ephemeral });
    const { data, error } = await supabase.from('punishments').select('*').eq('discord_id', userId).order('created_at', { ascending: false }).limit(20);
    if (error) return interaction.reply({ content: `❌ ${errMessage(error)}`, flags: MessageFlags.Ephemeral });
    if (!data?.length) return interaction.reply({ content: `✅ <@${userId}> não possui punições registradas.`, flags: MessageFlags.Ephemeral });
    const lines = data.map((x:any)=>{
      const active = !x.removed_at && (!x.blocked_until || new Date(x.blocked_until).getTime() > Date.now());
      const until = x.blocked_until ? `<t:${Math.floor(new Date(x.blocked_until).getTime()/1000)}:F>` : 'sem prazo';
      return `${active ? '🚫' : '✅'} **${x.punishment_type}** — ${x.reason}\nAplicada por: ${x.created_by === 'SYSTEM' ? 'Sistema' : `<@${x.created_by}>`} • Até: ${until}${x.removed_at ? ` • Removida por <@${x.removed_by}>` : ''}`;
    });
    return interaction.reply({ content: `📋 **HISTÓRICO DE PUNIÇÕES — <@${userId}>**\n\n${lines.join('\n\n')}`.slice(0, 1950), flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'cmd:config:step1') {
    if (!(await ensureAdmin(interaction)) || !isOwner(interaction.member as GuildMember)) return deny(interaction, '❌ Apenas o Dono pode configurar o bot.');
    const key = draftKey(interaction.guildId, interaction.user.id);
    configDrafts.set(key, {
      userId: interaction.user.id,
      guildId: interaction.guildId!,
      raffle_channel_id: interaction.fields.getTextInputValue('raffle_channel').trim() || null,
      verification_channel_id: interaction.fields.getTextInputValue('verification_channel').trim(),
      verification_log_channel_id: interaction.fields.getTextInputValue('verification_log_channel').trim(),
      purchase_log_channel_id: interaction.fields.getTextInputValue('purchase_log_channel').trim(),
      results_channel_id: interaction.fields.getTextInputValue('results_channel').trim()
    });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('cmd:config-next2').setLabel('Continuar configuração').setEmoji('➡️').setStyle(ButtonStyle.Primary)
    );
    return interaction.reply({ content: '✅ Canais salvos nesta configuração. Continue para cargos e logs.', components: [row], flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'cmd:config:step2') {
    if (!(await ensureAdmin(interaction)) || !isOwner(interaction.member as GuildMember)) return deny(interaction, '❌ Apenas o Dono pode configurar o bot.');
    const key = draftKey(interaction.guildId, interaction.user.id);
    const draft = configDrafts.get(key);
    if (!draft) return interaction.reply({ content: '❌ A configuração expirou. Use /configurar novamente.', flags: MessageFlags.Ephemeral });
    Object.assign(draft, {
      audit_channel_id: interaction.fields.getTextInputValue('audit_channel').trim(),
      owner_role_id: interaction.fields.getTextInputValue('owner_role').trim(),
      admin_role_id: interaction.fields.getTextInputValue('admin_role').trim(),
      unverified_role_id: interaction.fields.getTextInputValue('unverified_role').trim(),
      verified_role_id: interaction.fields.getTextInputValue('verified_role').trim()
    });
    configDrafts.set(key, draft);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('cmd:config-next3').setLabel('Finalizar tempos').setEmoji('➡️').setStyle(ButtonStyle.Primary)
    );
    return interaction.reply({ content: '✅ Cargos e canal de logs salvos. Falta apenas definir os tempos padrão.', components: [row], flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'cmd:config:step3') {
    if (!(await ensureAdmin(interaction)) || !isOwner(interaction.member as GuildMember)) return deny(interaction, '❌ Apenas o Dono pode configurar o bot.');
    const key = draftKey(interaction.guildId, interaction.user.id);
    const draft = configDrafts.get(key);
    if (!draft) return interaction.reply({ content: '❌ A configuração expirou. Use /configurar novamente.', flags: MessageFlags.Ephemeral });
    try {
      const reservation = positiveInt(interaction.fields.getTextInputValue('reservation_minutes'), 'Tempo da reserva')!;
      const review = positiveInt(interaction.fields.getTextInputValue('review_minutes'), 'Tempo da análise')!;
      if (reservation > 120 || review > 120) throw new Error('Os tempos devem ficar entre 1 e 120 minutos.');
      draft.default_reservation_minutes = reservation;
      draft.default_review_minutes = review;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await validateSettingsDraft(client, interaction.guildId!, draft);
      const saved = await saveGuildSettings(interaction.guildId!, draft);
      configDrafts.delete(key);
      await audit(client, 'CONFIGURACAO_ATUALIZADA', interaction.user.id, { servidor: interaction.guildId, reserva_min: saved.default_reservation_minutes, analise_min: saved.default_review_minutes });
      return interaction.editReply('✅ Configuração salva no Supabase. O bot já está usando os novos canais, cargos e tempos.');
    } catch (e) {
      if (interaction.deferred || interaction.replied) return interaction.editReply(`❌ ${errMessage(e)}`);
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId === 'cmd:publish-raffle') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const raffleId = interaction.fields.getTextInputValue('raffle_id').trim();
    const channelId = interaction.fields.getTextInputValue('channel_id').trim();
    const configured = getCachedSettings(interaction.guildId!).raffle_channel_id;
    const targetChannelId = channelId || configured || '';
    const channel = targetChannelId ? await client.channels.fetch(targetChannelId).catch(() => null) : interaction.channel;
    if (!channel?.isTextBased() || !channel.isSendable()) return interaction.editReply('❌ Canal inválido. Informe um canal onde o bot possa enviar mensagens, configure o canal de rifas em /configurar ou execute no canal desejado.');
    try {
      await publishRaffle(client, raffleId, channel);
      return interaction.editReply('✅ Painel da rifa publicado.');
    } catch (e) {
      return interaction.editReply(`❌ ${errMessage(e)}`);
    }
  }

  if (interaction.customId === 'cmd:create-coupon:step1') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    try {
      const code = interaction.fields.getTextInputValue('code').trim().toUpperCase();
      const discount = positiveInt(interaction.fields.getTextInputValue('discount'), 'Desconto')!;
      const minNumbers = positiveInt(interaction.fields.getTextInputValue('min_numbers'), 'Quantidade mínima')!;
      const maxUses = positiveInt(interaction.fields.getTextInputValue('max_uses'), 'Limite total')!;
      const maxUsesPerUser = positiveInt(interaction.fields.getTextInputValue('per_user'), 'Limite por usuário')!;
      if (discount > 100) return interaction.reply({ content: '❌ O desconto deve ficar entre 1% e 100%.', flags: MessageFlags.Ephemeral });
      const key = draftKey(interaction.guildId, interaction.user.id);
      couponDrafts.set(key, { userId: interaction.user.id, code, discount, minNumbers, maxUses, maxUsesPerUser });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('cmd:create-coupon-next').setLabel('Continuar').setEmoji('➡️').setStyle(ButtonStyle.Primary)
      );
      return interaction.reply({ content: '✅ Regras principais salvas. Clique abaixo para definir rifa e validade (opcionais).', components: [row], flags: MessageFlags.Ephemeral });
    } catch (e) {
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId === 'cmd:create-coupon:step2') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const key = draftKey(interaction.guildId, interaction.user.id);
    const draft = couponDrafts.get(key);
    if (!draft) return interaction.reply({ content: '❌ O formulário anterior expirou. Use /criar-cupom novamente.', flags: MessageFlags.Ephemeral });
    try {
      const name = interaction.fields.getTextInputValue('name').trim();
      const raffleId = interaction.fields.getTextInputValue('raffle_id').trim() || null;
      const days = positiveInt(interaction.fields.getTextInputValue('valid_days'), 'Validade', true);
      if (!name) return interaction.reply({ content: '❌ Informe o nome do cupom.', flags: MessageFlags.Ephemeral });
      if (days != null && days > 3650) return interaction.reply({ content: '❌ A validade máxima é 3650 dias.', flags: MessageFlags.Ephemeral });
      const expires = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
      const { data: createdCoupon, error } = await supabase.from('coupons').insert({
        name,
        code: draft.code,
        discount_percent: draft.discount,
        min_numbers: draft.minNumbers,
        max_uses: draft.maxUses,
        max_uses_per_user: draft.maxUsesPerUser,
        raffle_id: raffleId,
        expires_at: expires,
        created_by: interaction.user.id
      }).select('id,created_at').single();
      if (error) return interaction.reply({ content: `❌ ${errMessage(error)}`, flags: MessageFlags.Ephemeral });
      couponDrafts.delete(key);
      const createdAt = createdCoupon?.created_at ?? new Date().toISOString();
      await audit(client, 'CUPOM_CRIADO', interaction.user.id, {
        nome: name,
        codigo: draft.code,
        desconto: `${draft.discount}%`,
        minimo_numeros: draft.minNumbers,
        usos: `0/${draft.maxUses}`,
        limite_total: draft.maxUses,
        limite_por_pessoa: draft.maxUsesPerUser,
        validade: expires,
        criado_em: createdAt,
        rifa_id: raffleId ?? 'Todas as rifas',
        criador_discord_id: interaction.user.id
      });
      return interaction.reply({ content: `✅ Cupom **${draft.code}** criado.`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId === 'cmd:disable-coupon') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const code = interaction.fields.getTextInputValue('code').trim().toUpperCase();
    const { data, error } = await supabase.from('coupons').update({ active: false, updated_at: new Date().toISOString() }).eq('code', code).is('deleted_at', null).select('id').maybeSingle();
    if (error || !data) return interaction.reply({ content: `❌ Cupom não encontrado ou erro: ${errMessage(error)}`, flags: MessageFlags.Ephemeral });
    await audit(client, 'CUPOM_DESATIVADO', interaction.user.id, { codigo: code });
    return interaction.reply({ content: `✅ Cupom **${code}** desativado.`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'cmd:edit-coupon') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    try {
      const code = interaction.fields.getTextInputValue('code').trim().toUpperCase();
      const discount = positiveInt(interaction.fields.getTextInputValue('discount'), 'Desconto', true);
      const minNumbers = positiveInt(interaction.fields.getTextInputValue('min_numbers'), 'Quantidade mínima', true);
      const maxUses = positiveInt(interaction.fields.getTextInputValue('max_uses'), 'Limite total', true);
      const perUser = positiveInt(interaction.fields.getTextInputValue('per_user'), 'Limite por usuário', true);
      if (discount != null && discount > 100) return interaction.reply({ content: '❌ O desconto deve ficar entre 1% e 100%.', flags: MessageFlags.Ephemeral });
      const changes: Record<string, any> = { updated_at: new Date().toISOString() };
      if (discount != null) changes.discount_percent = discount;
      if (minNumbers != null) changes.min_numbers = minNumbers;
      if (maxUses != null) changes.max_uses = maxUses;
      if (perUser != null) changes.max_uses_per_user = perUser;
      if (Object.keys(changes).length === 1) return interaction.reply({ content: '❌ Preencha pelo menos um campo para alterar.', flags: MessageFlags.Ephemeral });
      const { data, error } = await supabase.from('coupons').update(changes).eq('code', code).is('deleted_at', null).select('id').maybeSingle();
      if (error || !data) return interaction.reply({ content: `❌ Cupom não encontrado ou erro: ${errMessage(error)}`, flags: MessageFlags.Ephemeral });
      await audit(client, 'CUPOM_EDITADO', interaction.user.id, { codigo: code, ...changes });
      return interaction.reply({ content: `✅ Cupom **${code}** atualizado.`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      return interaction.reply({ content: `❌ ${errMessage(e)}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId === 'cmd:delete-coupon') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const code = interaction.fields.getTextInputValue('code').trim().toUpperCase();
    const { data, error } = await supabase.from('coupons').update({ active: false, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('code', code).is('deleted_at', null).select('id').maybeSingle();
    if (error || !data) return interaction.reply({ content: `❌ Cupom não encontrado ou erro: ${errMessage(error)}`, flags: MessageFlags.Ephemeral });
    await audit(client, 'CUPOM_EXCLUIDO', interaction.user.id, { codigo: code });
    return interaction.reply({ content: `🗑️ Cupom **${code}** excluído. O histórico foi mantido.`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'cmd:coupon-uses') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const code = interaction.fields.getTextInputValue('code').trim().toUpperCase();
    const { data, error } = await supabase.from('purchases')
      .select('id,discord_id,total,discount_amount,discount_percent_snapshot,approved_at,purchase_numbers(number),raffles(name)')
      .eq('coupon_code_snapshot', code)
      .eq('status', 'approved')
      .order('approved_at', { ascending: false })
      .limit(20);
    if (error) return interaction.reply({ content: `❌ ${errMessage(error)}`, flags: MessageFlags.Ephemeral });
    if (!data?.length) return interaction.reply({ content: `🎫 O cupom **${code}** ainda não possui usos aprovados.`, flags: MessageFlags.Ephemeral });
    const ids = [...new Set(data.map((x:any)=>x.discord_id))];
    const { data: profiles } = await supabase.from('profiles').select('discord_id,mta_name,mta_id').in('discord_id', ids);
    const pm = new Map<string, any>((profiles ?? []).map((x:any)=>[x.discord_id,x]));
    const lines = data.map((x:any) => {
      const pr = pm.get(x.discord_id);
      return `• **${pr?.mta_name ?? 'Jogador'} | ${pr?.mta_id ?? '?'}** — ${x.purchase_numbers?.length ?? 0} nº — desconto ${money(x.discount_amount)} — pago ${money(x.total)}`;
    });
    return interaction.reply({ content: `🎫 **USOS APROVADOS — ${code}**\n\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'cmd:ranking') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const raffleId = interaction.fields.getTextInputValue('raffle_id').trim();
    let q = supabase.from('raffle_numbers').select('sold_to').eq('status', 'sold').not('sold_to', 'is', null);
    if (raffleId) q = q.eq('raffle_id', raffleId);
    const { data, error } = await q;
    if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
    const counts = new Map<string, number>();
    for (const row of data ?? []) counts.set(row.sold_to!, (counts.get(row.sold_to!) ?? 0) + 1);
    const top = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
    if (!top.length) return interaction.editReply('🏆 Ainda não há compras aprovadas para o ranking.');
    const ids = top.map(x=>x[0]);
    const { data: profiles } = await supabase.from('profiles').select('discord_id,mta_name,mta_id').in('discord_id', ids);
    const map = new Map<string, any>((profiles ?? []).map((p:any)=>[p.discord_id,p]));
    const medals = ['🥇','🥈','🥉'];
    const lines = top.map(([id,count],i)=>`${medals[i] ?? `${i+1}º`} **${map.get(id)?.mta_name ?? 'Jogador'} | ${map.get(id)?.mta_id ?? '?'}** — ${count} números`);
    return interaction.editReply(`🏆 **RANKING ${raffleId ? 'DA RIFA' : 'GERAL'}**\n\n${lines.join('\n')}`);
  }

  if (interaction.customId === 'cmd:republish-result') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const raffleId = interaction.fields.getTextInputValue('raffle_id').trim();
    const [{ data: result, error: resultError }, { data: raffle }] = await Promise.all([
      supabase.from('raffle_results').select('*').eq('raffle_id', raffleId).maybeSingle(),
      supabase.from('raffles').select('name,image_url').eq('id', raffleId).maybeSingle()
    ]);
    if (resultError || !result) return interaction.editReply('❌ Não existe resultado salvo para essa rifa.');
    const { data: profile } = await supabase.from('profiles').select('mta_name,mta_id').eq('discord_id', result.winner_discord_id).maybeSingle();
    const channel = await client.channels.fetch(getCachedSettings(interaction.guildId!).results_channel_id).catch(()=>null);
    if (!channel?.isTextBased() || !channel.isSendable()) return interaction.editReply('❌ O canal de resultados está indisponível ou não permite envio de mensagens.');

    const winnerName = profile?.mta_name ?? 'N/D';
    const winnerMtaId = profile?.mta_id ?? result.winner_mta_id ?? 'N/D';
    const winnerPhone = result.winner_game_phone ?? 'N/D';
    const embed = new EmbedBuilder()
      .setTitle('🏆 RESULTADO DA RIFA')
      .setDescription(
        `🎟️ Rifa: **${raffle?.name ?? 'Rifa'}**\n` +
        `🎲 Número vencedor: **#${result.winning_number}**\n` +
        `👤 Vencedor: **${winnerName} | ${winnerMtaId}** (<@${result.winner_discord_id}>)\n` +
        `🆔 ID: **${winnerMtaId}**\n` +
        `📱 Telefone: **${winnerPhone}**\n\n` +
        `🎉 Parabéns ao vencedor!`
      )
      .setFooter({ text: `Resultado salvo em ${new Date(result.drawn_at).toLocaleString('pt-BR')}` })
      .setTimestamp(new Date(result.drawn_at));
    if (raffle?.image_url) embed.setThumbnail(raffle.image_url);
    try {
      await channel.send({ content: `<@${result.winner_discord_id}>`, embeds: [embed] });
    } catch (e) {
      console.error('Falha ao republicar resultado:', e);
      return interaction.editReply('❌ O resultado existe no banco, mas o Discord recusou a publicação. Confira as permissões do canal.');
    }
    await audit(client, 'RESULTADO_REPUBLICADO', interaction.user.id, { rifa_id: raffleId, numero: result.winning_number }, result.winner_discord_id, 'raffle', raffleId);
    return interaction.editReply('✅ Resultado republicado sem realizar um novo sorteio.');
  }

  if (interaction.customId === 'cmd:draw') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const raffleId = interaction.fields.getTextInputValue('raffle_id').trim();

    const resultChannel = await client.channels.fetch(getCachedSettings(interaction.guildId!).results_channel_id).catch(()=>null);
    if (!resultChannel?.isTextBased() || !resultChannel.isSendable()) {
      return interaction.editReply('❌ O canal de resultados está indisponível. O sorteio NÃO foi realizado. Corrija o canal e tente novamente.');
    }

    // O banco escolhe e grava o vencedor dentro da mesma transação. Isso evita
    // que uma aprovação concorrente fique fora do conjunto do sorteio.
    const { data: result, error: drawError } = await supabase.rpc('finalize_random_draw', {
      p_raffle_id: raffleId,
      p_drawn_by: interaction.user.id
    });
    if (drawError) return interaction.editReply(`❌ ${errMessage(drawError)}`);
    const resultRow = rpcOne<any>(result);
    if (!resultRow) return interaction.editReply('❌ O banco não retornou o resultado do sorteio.');

    const [{ data: raffle }, { data: profile }] = await Promise.all([
      supabase.from('raffles').select('name,image_url').eq('id', raffleId).single(),
      supabase.from('profiles').select('mta_name,mta_id').eq('discord_id', resultRow.winner_discord_id).single()
    ]);
    const winnerPhone = resultRow.winner_game_phone ?? 'N/D';
    const winnerName = profile?.mta_name ?? 'N/D';
    const winnerMtaId = profile?.mta_id ?? resultRow.winner_mta_id ?? 'N/D';
    const channel = resultChannel;
    {
      const embed = new EmbedBuilder()
        .setTitle('🏆 RESULTADO DA RIFA')
        .setDescription(
          `🎟️ Rifa: **${raffle?.name ?? 'Rifa'}**\n` +
          `🎲 Número vencedor: **#${resultRow.winning_number}**\n` +
          `👤 Vencedor: **${winnerName} | ${winnerMtaId}** (<@${resultRow.winner_discord_id}>)\n` +
          `🆔 ID: **${winnerMtaId}**\n` +
          `📱 Telefone: **${winnerPhone}**\n\n` +
          `🎉 Parabéns ao vencedor!`
        )
        .setFooter({ text: `Sorteado por ${interaction.user.tag}` })
        .setTimestamp();
      if (raffle?.image_url) embed.setThumbnail(raffle.image_url);
      try {
        await channel.send({ content: `<@${resultRow.winner_discord_id}>`, embeds: [embed] });
      } catch (publishError) {
        console.error('Sorteio salvo, mas falhou a publicação do resultado:', publishError);
        await refreshRafflePanel(client, raffleId).catch(()=>null);
        return interaction.editReply(`⚠️ Sorteio realizado e salvo no banco: **#${resultRow.winning_number}**, mas não foi possível publicar no canal de resultados. Corrija as permissões e consulte o histórico antes de tentar qualquer novo sorteio.`);
      }
    }
    const winnerUser = await client.users.fetch(resultRow.winner_discord_id).catch(()=>null);
    await winnerUser?.send(`🏆 Você ganhou a rifa **${raffle?.name ?? 'Rifa'}** com o número **#${resultRow.winning_number}**! Telefone registrado: **${winnerPhone}**.`).catch(()=>null);
    await refreshRafflePanel(client, raffleId);
    return interaction.editReply(`✅ Sorteio realizado. Número **#${resultRow.winning_number}**. Resultado publicado com o telefone do vencedor.`);
  }

  if (interaction.customId === 'cmd:punish') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const userId = discordUserId(interaction.fields.getTextInputValue('user'));
    if (!userId) return interaction.reply({ content: '❌ Informe o ID do Discord ou uma menção válida do usuário.', flags: MessageFlags.Ephemeral });
    const rawDuration = interaction.fields.getTextInputValue('duration').trim().toLowerCase();
    const duration = rawDuration === 'permanente' ? 'permanent' : rawDuration;
    const reason = interaction.fields.getTextInputValue('reason').trim();
    const msMap: Record<string, number> = { '30m': 30*60000, '1h': 3600000, '6h': 6*3600000, '24h': 24*3600000, '7d': 7*86400000 };
    if (duration !== 'permanent' && !msMap[duration]) return interaction.reply({ content: '❌ Duração inválida. Use: 30m, 1h, 6h, 24h, 7d ou permanente.', flags: MessageFlags.Ephemeral });
    const until = duration === 'permanent' ? '9999-12-31T23:59:59.000Z' : new Date(Date.now()+msMap[duration]).toISOString();
    const { data: prof } = await supabase.from('profiles').select('id').eq('discord_id', userId).maybeSingle();
    if (!prof) return interaction.reply({ content: '❌ Esse usuário ainda não possui perfil verificado no sistema.', flags: MessageFlags.Ephemeral });
    await supabase.from('profiles').update({ blocked_until: until }).eq('discord_id', userId);
    await supabase.from('punishments').insert({ discord_id: userId, punishment_type: duration==='permanent'?'permanent':'temporary', reason, blocked_until: until, created_by: interaction.user.id });
    const user = await client.users.fetch(userId).catch(()=>null);
    await audit(client, 'PUNICAO_APLICADA', interaction.user.id, { usuario: user?.tag ?? userId, duracao: duration, motivo: reason }, userId);
    return interaction.reply({ content: `🚫 <@${userId}> bloqueado do sistema de rifas (${rawDuration}).`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'cmd:unpunish') {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const userId = discordUserId(interaction.fields.getTextInputValue('user'));
    if (!userId) return interaction.reply({ content: '❌ Informe o ID do Discord ou uma menção válida do usuário.', flags: MessageFlags.Ephemeral });
    const reason = interaction.fields.getTextInputValue('reason').trim();
    await supabase.from('profiles').update({ blocked_until: null }).eq('discord_id', userId);
    await supabase.from('punishments').update({ removed_by: interaction.user.id, removed_at: new Date().toISOString(), removal_reason: reason }).eq('discord_id', userId).is('removed_at', null);
    const user = await client.users.fetch(userId).catch(()=>null);
    await audit(client, 'PUNICAO_REMOVIDA', interaction.user.id, { usuario: user?.tag ?? userId, motivo: reason }, userId);
    return interaction.reply({ content: `✅ Bloqueio de <@${userId}> removido.`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'verify:modal') {
    const mtaName = interaction.fields.getTextInputValue('mta_name').trim();
    const mtaIdRaw = interaction.fields.getTextInputValue('mta_id').trim();
    if (!/^\d+$/.test(mtaIdRaw)) return interaction.reply({ content:'❌ O ID deve conter somente números.', flags: MessageFlags.Ephemeral });

    const verificationLog = await client.channels.fetch(getCachedSettings(interaction.guildId!).verification_log_channel_id).catch(()=>null);
    if (!verificationLog?.isTextBased() || !verificationLog.isSendable()) {
      return interaction.reply({ content: '❌ O canal privado de verificação está indisponível. Avise um Dono/ADM.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { data: req, error } = await supabase.rpc('request_verification', { p_discord_id: interaction.user.id, p_mta_name: mtaName, p_mta_id: Number(mtaIdRaw) });
    if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
    const reqRow = rpcOne<any>(req);
    if (!reqRow) return interaction.editReply('❌ O banco não retornou a solicitação.');
    const channel = verificationLog;
    {
      const embed = new EmbedBuilder().setTitle('🪪 Nova solicitação de verificação').addFields(
        { name:'Discord', value:`<@${interaction.user.id}> (${interaction.user.id})` },
        { name:'Nome Legacy', value:reqRow.mta_name, inline:true },
        { name:'ID Legacy', value:String(reqRow.mta_id), inline:true },
        { name:'Status', value:'⏳ Aguardando análise' }
      ).setFooter({text:`Verificação ID: ${reqRow.id}`}).setTimestamp();
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`verifyapprove:${reqRow.id}`).setLabel('Aprovar').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`verifyreject:${reqRow.id}`).setLabel('Recusar').setEmoji('❌').setStyle(ButtonStyle.Danger)
      );
      try {
        const reviewMessage = await channel.send({ embeds:[embed], components:[row] });
        const { error: saveMessageError } = await supabase.from('verification_requests').update({
          review_channel_id: channel.id,
          review_message_id: reviewMessage.id
        }).eq('id', reqRow.id);
        if (saveMessageError) console.error('Falha ao salvar referência da mensagem de verificação:', saveMessageError);
      } catch (sendError) {
        // Evita deixar solicitação pendente invisível que impediria uma nova tentativa.
        await supabase.from('verification_requests').update({
          status: 'rejected',
          reviewed_by: 'SYSTEM',
          reviewed_at: new Date().toISOString(),
          rejection_reason: 'Falha ao publicar no canal de análise'
        }).eq('id', reqRow.id).eq('status', 'pending');
        console.error('Falha ao publicar verificação:', sendError);
        return interaction.editReply('❌ Não foi possível enviar sua verificação para a equipe. Tente novamente em alguns instantes.');
      }
    }
    return interaction.editReply('✅ Solicitação enviada para a equipe. Aguarde Dono/ADM analisar.');
  }

  if (interaction.customId.startsWith('verifyrejectmodal:')) {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const id = interaction.customId.split(':')[1];
    const reason = interaction.fields.getTextInputValue('reason').trim();
    const { data: requestRow } = await supabase.from('verification_requests')
      .select('discord_id,mta_name,mta_id')
      .eq('id', id)
      .single();
    const { error } = await supabase.rpc('reject_verification', { p_request_id:id, p_admin_id:interaction.user.id, p_reason:reason });
    if (error) return interaction.reply({content:`❌ ${errMessage(error)}`,flags: MessageFlags.Ephemeral});
    if (interaction.message && requestRow) {
      const rejectedEmbed = new EmbedBuilder()
        .setTitle('❌ Verificação recusada')
        .addFields(
          { name:'Discord', value:`<@${requestRow.discord_id}> (${requestRow.discord_id})` },
          { name:'Nome Legacy', value:String(requestRow.mta_name), inline:true },
          { name:'ID Legacy', value:String(requestRow.mta_id), inline:true },
          { name:'Motivo', value:reason },
          { name:'Status', value:`❌ Recusado por <@${interaction.user.id}>` }
        )
        .setFooter({ text:`Verificação ID: ${id}` })
        .setTimestamp();
      await interaction.message.edit({embeds:[rejectedEmbed],components:[]}).catch(()=>null);
      // Em recusas, o LGC Win não adiciona nem remove o cargo "Membro não verificado".
      // O cargo inicial é responsabilidade da Loritta.
      const rejectedUser = await client.users.fetch(requestRow.discord_id).catch(()=>null);
      await rejectedUser?.send(`❌ Sua verificação foi recusada. Motivo: **${reason}**`).catch(()=>null);
    }
    return interaction.reply({content:'❌ Verificação recusada e registrada no log.',flags: MessageFlags.Ephemeral});
  }

  if (interaction.customId.startsWith('buy:modal:')) {
    const eligibilityError = await purchaseEligibilityError(interaction);
    if (eligibilityError) return interaction.reply({ content: eligibilityError, flags: MessageFlags.Ephemeral });

    const raffleId = interaction.customId.split(':')[2];
    const nums = parseNumbers(interaction.fields.getTextInputValue('numbers'));
    const phone = interaction.fields.getTextInputValue('phone').trim();
    const coupon = interaction.fields.getTextInputValue('coupon').trim();
    if (!nums.length || nums.some(n=>!Number.isInteger(n))) return interaction.reply({content:'❌ Informe números válidos separados por vírgula.',flags: MessageFlags.Ephemeral});
    if (!/^\d{1,6}$/.test(phone)) return interaction.reply({content:'❌ Telefone do jogo deve ter somente números e no máximo 6 dígitos.',flags: MessageFlags.Ephemeral});

    const purchaseLog = await client.channels.fetch(getCachedSettings(interaction.guildId!).purchase_log_channel_id).catch(()=>null);
    if (!purchaseLog?.isTextBased() || !purchaseLog.isSendable()) {
      return interaction.reply({ content: '❌ O canal de análise das compras está indisponível. Nenhum número foi reservado. Avise um Dono/ADM.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({flags: MessageFlags.Ephemeral});
    const { data: purchase, error } = await supabase.rpc('reserve_numbers', {
      p_raffle_id: raffleId,
      p_discord_id: interaction.user.id,
      p_numbers: nums,
      p_game_phone: phone,
      p_coupon_code: coupon || null,
      p_bypass_active_purchase: isOwner(member)
    });
    if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
    const purchaseRow = rpcOne<any>(purchase);
    if (!purchaseRow) return interaction.editReply('❌ O banco não retornou a compra.');
    try {
      await postPurchaseForReview(client, purchaseRow.id);
    } catch (postError) {
      console.error('Falha ao publicar compra para análise; liberando reserva:', postError);
      const { error: rollbackError } = await supabase.rpc('cancel_pending_purchase_system', {
        p_purchase_id: purchaseRow.id,
        p_reason: 'Falha ao publicar a compra no canal administrativo'
      });
      await refreshRafflePanel(client, raffleId).catch(()=>null);
      if (rollbackError) {
        console.error('Falha CRÍTICA ao liberar reserva após erro de publicação:', rollbackError);
        return interaction.editReply('⚠️ A compra não pôde ser publicada e houve falha ao liberar automaticamente os números. Avise um Dono/ADM informando o ID da compra: `' + purchaseRow.id + '`.');
      }
      return interaction.editReply('❌ Não foi possível enviar a compra para análise. Os números foram liberados; tente novamente em alguns instantes.');
    }
    await refreshRafflePanel(client, raffleId);
    const { embed } = await buildPurchaseEmbed(purchaseRow.id);
    return interaction.editReply({ content:'✅ Números reservados. Faça o pagamento dentro do MTA. Sua compra já foi enviada para análise dos ADMs.', embeds:[embed] });
  }

  if (interaction.customId.startsWith('purchaserejectmodal:')) {
    if (!(await ensureAdmin(interaction))) return deny(interaction);
    const id = interaction.customId.split(':')[1];
    const reason = interaction.fields.getTextInputValue('reason');
    await interaction.deferReply({flags: MessageFlags.Ephemeral});
    const { data: purchase, error } = await supabase.rpc('reject_purchase', { p_purchase_id:id, p_admin_id:interaction.user.id, p_reason:reason });
    if (error) return interaction.editReply(`❌ ${errMessage(error)}`);
    const purchaseRow = rpcOne<any>(purchase);
    if (!purchaseRow) return interaction.editReply('❌ O banco não retornou a compra recusada.');
    await refreshPurchaseReviewMessage(client,id);
    await refreshRafflePanel(client,purchaseRow.raffle_id);
    const user = await client.users.fetch(purchaseRow.discord_id).catch(()=>null);
    await user?.send(`❌ Sua compra foi recusada. Motivo: **${reason}**`).catch(()=>null);
    return interaction.editReply('❌ Compra recusada e números liberados.');
  }
}

export async function handleInteraction(client: Client, interaction: Interaction) {
  try {
    if (interaction.isChatInputCommand()) return await handleCommand(client, interaction);
    if (interaction.isButton()) return await handleButton(client, interaction);
    if (interaction.isStringSelectMenu()) return await handleStringSelectMenu(client, interaction);
    if (interaction.isModalSubmit()) return await handleModal(client, interaction);
  } catch (e) {
    console.error('Erro interno em interactionCreate:', e);
    if ('reply' in interaction) {
      const payload = { content:'❌ Não foi possível concluir essa ação. Tente novamente. Se continuar, avise um Dono/ADM.', flags: MessageFlags.Ephemeral } as any;
      if ((interaction as any).replied || (interaction as any).deferred) await (interaction as any).followUp(payload).catch(()=>null);
      else await (interaction as any).reply(payload).catch(()=>null);
    }
  }
}

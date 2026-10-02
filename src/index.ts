import { Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { config } from './config.js';
import { handleInteraction } from './handlers/interactions.js';
import { loadGuildSettings } from './services/guild-settings.js';
import { runMaintenance } from './services/maintenance.js';
import { validateStartup } from './services/health.js';
import { applyVerificationRoles } from './services/member-roles.js';
import { supabase } from './services/supabase.js';
import { syncSlashCommands } from './command-sync.js';

let appReady = false;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

client.once('clientReady', async () => {
  try {
    console.log(`✅ Bot online como ${client.user?.tag}`);
    console.log(`🏠 Servidor configurado: ${config.DISCORD_GUILD_ID}`);

    await loadGuildSettings(config.DISCORD_GUILD_ID);
    console.log('⚙️ Configuração do servidor carregada.');

    await validateStartup(client);

    // Faz a limpeza IMEDIATAMENTE após reinício, sem esperar o primeiro intervalo.
    await runMaintenance(client).catch(e => console.error('Erro na manutenção inicial:', e));
    appReady = true;
    console.log('🚀 LGC Win pronto para uso.');

    // Intervalo curto para reduzir o período em que uma reserva vencida continua visível.
    // A função possui trava interna e não roda duas instâncias sobrepostas.
    setInterval(() => {
      void runMaintenance(client).catch(e => console.error('Erro no worker de manutenção:', e));
    }, 30_000);
  } catch (e) {
    console.error('❌ Falha na validação inicial do bot:', e);
    console.error('O bot foi conectado ao Discord, mas a configuração/banco precisa ser corrigida antes do uso público.');
  }
});

client.on('guildMemberAdd', member => {
  if (member.user.bot || member.guild.id !== config.DISCORD_GUILD_ID) return;

  // A Loritta (ou outro bot do servidor) é responsável por entregar o cargo
  // "Membro não verificado". O LGC Win nunca adiciona esse cargo na entrada.
  // Se a pessoa JÁ estiver verificada no Supabase e voltar ao servidor, apenas
  // restauramos "Membro verificado" e removemos "Membro não verificado".
  void (async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('verified')
        .eq('discord_id', member.id)
        .maybeSingle();

      if (error) throw error;
      if (!data?.verified) {
        console.log(`👤 ${member.user.tag}: aguardando verificação; cargo inicial fica por conta da Loritta.`);
        return;
      }

      await applyVerificationRoles(member, true, 'Restauração automática ao voltar ao servidor');
      console.log(`👤 ${member.user.tag}: cargo Membro verificado restaurado.`);
    } catch (error: unknown) {
      console.error(`Erro ao restaurar verificação de ${member.user.tag}:`, error);
    }
  })();
});

client.on('interactionCreate', interaction => {
  if (!appReady) {
    if (interaction.isRepliable()) {
      void interaction.reply({ content: '⚠️ O bot está online, mas ainda não passou na validação do banco/configuração. Avise o Dono/ADM.', flags: MessageFlags.Ephemeral }).catch(() => null);
    }
    return;
  }
  void handleInteraction(client, interaction);
});
client.on('error', console.error);
client.on('warn', message => console.warn('Discord warning:', message));
process.on('unhandledRejection', reason => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', error => console.error('Uncaught exception:', error));

// Primeiro sincroniza os slash commands pela API HTTP do Discord.
// Depois conecta o Gateway para deixar o bot online.
// Se o Discord bloquear uma criação (por exemplo, limite 30034),
// o bot ainda conecta para não ficar completamente offline.
console.log('📝 Primeiro carregando os comandos / do LGC Win...');
try {
  await syncSlashCommands();
  console.log('✅ Comandos / carregados. Agora conectando o bot...');
} catch (error) {
  console.error('⚠️ Os comandos / não puderam ser sincronizados antes da conexão:', error);
  console.error('⚠️ O bot continuará para o Gateway; não tente registrar repetidamente se o Discord retornar 429/30034.');
}

await client.login(config.DISCORD_TOKEN);

import { SlashCommandBuilder } from 'discord.js';

// IMPORTANTE: nenhum comando recebe campos diretamente na barra `/`.
// Quando precisa de dados, o bot abre Modal depois que o usuário envia o comando.
export const commands = [
  new SlashCommandBuilder().setName('publicar-verificacao').setDescription('Publica o painel de verificação (Dono/ADM).'),
  new SlashCommandBuilder().setName('criar-rifa').setDescription('Abre o formulário para criar uma nova rifa (Dono/ADM).'),
  new SlashCommandBuilder().setName('editar-rifa').setDescription('Abre o formulário para editar uma rifa (Dono/ADM).'),
  new SlashCommandBuilder().setName('gerenciar-rifa').setDescription('Pausa, reativa, encerra ou exclui uma rifa (Dono/ADM).'),
  new SlashCommandBuilder().setName('publicar-rifa').setDescription('Abre o formulário para publicar uma rifa (Dono/ADM).'),
  new SlashCommandBuilder().setName('numeros-rifa').setDescription('Consulta os números disponíveis, reservados e vendidos (Dono/ADM).'),
  new SlashCommandBuilder().setName('criar-cupom').setDescription('Abre o formulário para criar um cupom (Dono/ADM).'),
  new SlashCommandBuilder().setName('ativar-cupom').setDescription('Abre o formulário para ativar um cupom (Dono/ADM).'),
  new SlashCommandBuilder().setName('desativar-cupom').setDescription('Abre o formulário para desativar um cupom (Dono/ADM).'),
  new SlashCommandBuilder().setName('editar-cupom').setDescription('Abre o formulário para editar um cupom (Dono/ADM).'),
  new SlashCommandBuilder().setName('excluir-cupom').setDescription('Abre o formulário para excluir um cupom (Dono/ADM).'),
  new SlashCommandBuilder().setName('cupom-usos').setDescription('Abre o formulário para consultar usos de um cupom (Dono/ADM).'),
  new SlashCommandBuilder().setName('ranking').setDescription('Abre o formulário do ranking geral ou de uma rifa.'),
  new SlashCommandBuilder().setName('perfil').setDescription('Mostra seu perfil no sistema de rifas.'),
  new SlashCommandBuilder().setName('minhas-compras').setDescription('Mostra suas compras recentes.'),
  new SlashCommandBuilder().setName('sortear').setDescription('Abre o formulário para realizar o sorteio (Dono/ADM).'),
  new SlashCommandBuilder().setName('republicar-resultado').setDescription('Republica um resultado já salvo no banco (Dono/ADM).'),
  new SlashCommandBuilder().setName('punir').setDescription('Abre o formulário para bloquear um usuário das rifas (Dono/ADM).'),
  new SlashCommandBuilder().setName('remover-punicao').setDescription('Abre o formulário para remover uma punição (Dono/ADM).'),
  new SlashCommandBuilder().setName('historico-punicoes').setDescription('Consulta o histórico de punições de um usuário (Dono/ADM).'),
  new SlashCommandBuilder().setName('painel').setDescription('Mostra o painel administrativo do sistema (Dono/ADM).'),
  new SlashCommandBuilder().setName('configurar').setDescription('Abre a configuração do bot para este servidor (Dono).'),
  new SlashCommandBuilder().setName('backup').setDescription('Gera um backup JSON do sistema (Dono).'),
  new SlashCommandBuilder().setName('status-bot').setDescription('Testa a conexão do bot e do Supabase.'),
  new SlashCommandBuilder().setName('aviso').setDescription('Abre um modal para o bot enviar um aviso organizado neste canal (Dono/ADM).')
].map(c => c.toJSON());

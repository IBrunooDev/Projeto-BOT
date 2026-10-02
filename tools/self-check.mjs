import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.cwd());
const errors = [];
const assert = (condition, message) => { if (!condition) errors.push(message); };
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
assert(pkg.version === '1.1.7', 'package.json precisa estar na versão 1.1.7.');

const commands = read('src/commands.ts');
assert(!/\.add(?:String|Integer|Number|Boolean|User|Role|Channel|Mentionable|Attachment)Option\s*\(/.test(commands), 'Existe comando / com opção na barra; os dados devem abrir por modal.');

const interactions = read('src/handlers/interactions.ts');
assert(interactions.includes("rpc('finalize_random_draw'"), 'Sorteio não está usando finalize_random_draw.');
assert(interactions.includes('purchaseEligibilityError(interaction)'), 'Compra não está revalidando elegibilidade.');
assert(interactions.includes("rpc('cancel_pending_purchase_system'"), 'Rollback de reserva sem log administrativo não encontrado.');
assert(interactions.includes('applyVerificationRoles(guildMember, true'), 'Aprovação não está trocando cargos de verificação.');

const index = read('src/index.ts');
assert(index.includes('await runMaintenance(client)'), 'Manutenção inicial não encontrada.');
assert(index.includes('appReady = true'), 'Trava de prontidão não encontrada.');
assert(index.includes("client.on('guildMemberAdd'"), 'Restauração de verificados na entrada não encontrada.');
assert(index.includes('aguardando verificação; cargo inicial fica por conta da Loritta'), 'Entrada ainda não está delegada à Loritta.');

assert(index.includes('catch (error: unknown)'), 'Tratamento tipado do guildMemberAdd não encontrado.');
assert(!index.includes('.maybeSingle()\n    .then'), 'guildMemberAdd ainda encadeia PromiseLike com .then/.catch.');
assert(interactions.includes('isSendable()'), 'Validação isSendable() não encontrada nas interações.');
const auditTs = read('src/services/audit.ts');
const purchaseUiTs = read('src/services/purchase-ui.ts');
const raffleUiTs = read('src/services/raffle-ui.ts');
assert(auditTs.includes('channel.isSendable()'), 'Audit log não valida canal enviável.');
assert(purchaseUiTs.includes('channel.isSendable()'), 'Log de compras não valida canal enviável.');
assert(raffleUiTs.includes('channel.isSendable()'), 'Publicação de rifa não valida canal enviável.');
assert(raffleUiTs.includes('Criada por'), 'Painel da rifa não mostra quem criou a rifa.');
assert(raffleUiTs.includes('created_by'), 'Painel da rifa não usa o criador salvo no banco.');
assert(interactions.includes('criada_por:'), 'Log de criação não registra quem criou a rifa.');
assert(interactions.includes('descricao: raffle.description'), 'Log de criação não registra a descrição da rifa.');
assert(raffleUiTs.includes('Números disponíveis'), 'Painel da rifa não mostra os números disponíveis.');
assert(raffleUiTs.includes('numbers:view:'), 'Painel da rifa não possui consulta visual de números.');
assert(interactions.includes('StringSelectMenuBuilder'), 'Seleção visual de números não está configurada.');
assert(interactions.includes('showNumberPicker'), 'Seletor visual de números não foi implementado.');

const memberRoles = read('src/services/member-roles.ts');
assert(!memberRoles.includes('await member.roles.add(settings.unverified_role_id'), 'LGC Win ainda adiciona Membro não verificado; isso deve ficar com a Loritta.');

const sql = read('BANCO-ZERADO-v1.1.7.sql');
assert(sql.includes("values('schema_version','1.1.2')"), 'schema_version 1.1.2 não encontrado.');
assert(!sql.includes('purchases_one_active_user_uq'), 'O índice antigo de compra ativa única não deve bloquear o Dono.');
assert(sql.includes('p_bypass_active_purchase boolean default false'), 'O banco não possui o bypass de compra ativa para o Dono.');
assert(sql.includes('finalize_random_draw'), 'Função de sorteio atômico não encontrada.');
assert(sql.includes('apply_abandonment_penalty'), 'Punição progressiva não encontrada.');
assert(sql.includes('cancel_pending_purchase_system'), 'Função de rollback de compra não encontrada.');
assert(sql.includes('unverified_role_id text'), 'Coluna unverified_role_id não encontrada no banco.');
assert((sql.match(/\$\$/g) ?? []).length % 2 === 0, 'Blocos $$ do SQL estão desbalanceados.');

const config = read('src/config.ts');
assert(config.includes('MIN_SERVER_MINUTES'), 'MIN_SERVER_MINUTES não existe na configuração.');
assert(config.includes('PURCHASE_COOLDOWN_MINUTES'), 'PURCHASE_COOLDOWN_MINUTES não existe na configuração.');
assert(interactions.includes('isOwner(member)'), 'A exceção do cooldown para o Dono não foi encontrada.');
assert(!interactions.includes('config.MIN_SERVER_HOURS'), 'Interações ainda usam MIN_SERVER_HOURS; devem usar minutos.');
assert(interactions.includes('config.MIN_SERVER_MINUTES'), 'Interações não usam MIN_SERVER_MINUTES.');

const env = read('.env.example');
assert(env.includes('MIN_SERVER_MINUTES=20'), 'O .env deve vir com MIN_SERVER_MINUTES=20.');
assert(!env.includes('MIN_SERVER_HOURS='), 'O .env novo não deve usar MIN_SERVER_HOURS.');
assert(env.includes('UNVERIFIED_ROLE_ID='), 'UNVERIFIED_ROLE_ID não existe no .env.');
assert(env.includes('PURCHASE_COOLDOWN_MINUTES='), 'PURCHASE_COOLDOWN_MINUTES não existe no .env.');
for (const key of ['DISCORD_TOKEN','SUPABASE_SECRET_KEY']) {
  const line = env.split(/\r?\n/).find(x => x.startsWith(`${key}=`));
  assert(Boolean(line), `${key} não existe no .env.`);
  const value = line?.slice(key.length + 1).trim() ?? '';
  assert(value === '', `${key} deve vir vazio no .env.example.`);
}

if (errors.length) {
  console.error('❌ Self-check falhou:');
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log('✅ Self-check do pacote v1.1.7 concluído sem falhas.');

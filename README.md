# LGC Win — Bot de Rifas para Discord

> Projeto de estudo — v1.1.7

<div align="center" border="50%">
  <img width="864" height="573" alt="image" src="https://github.com/user-attachments/assets/aa2cc2a4-80a6-4c7a-a9be-a83502148eb0" />
</div>

O **LGC Win** é um bot para Discord criado para estudar, na prática, desenvolvimento de aplicações com **Node.js, TypeScript, Discord.js e Supabase**.

Este projeto foi desenvolvido **com auxílio de Inteligência Artificial (IA)** como parte de um projeto de estudo/conclusão. A IA foi utilizada como apoio durante o desenvolvimento, organização, revisão e implementação de funcionalidades.

## Sobre o projeto

O bot reúne em um único sistema recursos para gerenciamento de rifas e comunidade no Discord, incluindo:

- criação e edição de rifas;
- controle de números disponíveis;
- reservas e compras de números;
- análise e aprovação de compras;
- sistema de cupons de desconto;
- logs e auditoria de ações administrativas;
- verificação de membros;
- alteração de apelido após verificação;
- ranking de compradores;
- publicação de resultado da rifa;
- log separado para cupons;
- log separado para avisos;
- integração com Supabase para persistência dos dados;
- sincronização dos comandos slash do Discord.

## Tecnologias

- **Node.js 20+**
- **TypeScript**
- **Discord.js 14**
- **Supabase / PostgreSQL**
- **Zod** para validação das variáveis de ambiente
- **dotenv** para configuração local

## Estrutura

```text
LGC-Win-v1.1.7-GITHUB/
├── src/
│   ├── commands.ts
│   ├── command-sync.ts
│   ├── config.ts
│   ├── deploy-commands.ts
│   ├── handlers/
│   ├── services/
│   └── utils/
├── supabase/
│   └── schema.sql
├── tools/
│   └── self-check.mjs
├── BANCO-ZERADO-v1.1.7.sql
├── VALIDAR-BANCO-v1.1.7.sql
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## Configuração

### 1. Requisitos

Instale:

- Node.js 20 ou superior;
- uma aplicação criada no Discord Developer Portal;
- um servidor Discord para testes;
- um projeto Supabase.

### 2. Configurar o ambiente

Copie `.env.example` para `.env` e preencha os valores do seu próprio ambiente.

Exemplo:

```env
DISCORD_TOKEN=SEU_TOKEN
DISCORD_CLIENT_ID=SEU_CLIENT_ID
DISCORD_GUILD_ID=SEU_GUILD_ID

OWNER_ROLE_ID=ID_DO_CARGO_DONO
ADMIN_ROLE_ID=ID_DO_CARGO_ADMIN
UNVERIFIED_ROLE_ID=ID_DO_CARGO_NAO_VERIFICADO
VERIFIED_ROLE_ID=ID_DO_CARGO_VERIFICADO

VERIFICATION_CHANNEL_ID=ID_DO_CANAL
VERIFICATION_LOG_CHANNEL_ID=ID_DO_CANAL
PURCHASE_LOG_CHANNEL_ID=ID_DO_CANAL
RESULTS_CHANNEL_ID=ID_DO_CANAL
AUDIT_CHANNEL_ID=ID_DO_CANAL
COUPON_LOG_CHANNEL_ID=ID_DO_CANAL_DE_CUPONS
NOTICE_LOG_CHANNEL_ID=ID_DO_CANAL_DE_AVISOS

SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SECRET_KEY=SUA_CHAVE_SECRETA
```

Os valores acima são apenas exemplos. **Nunca publique o arquivo `.env`.**

### 3. Banco de dados

Para uma instalação limpa:

1. Abra o SQL Editor do seu projeto Supabase.
2. Execute `BANCO-ZERADO-v1.1.7.sql`.
3. Depois execute `VALIDAR-BANCO-v1.1.7.sql`.
4. Confira o resultado da validação antes de iniciar o bot.

O banco zerado é destinado a uma instalação limpa e pode apagar as estruturas/dados existentes do sistema de rifa. Não execute esse arquivo em uma instalação com dados que você deseja preservar.

## Instalação

No Windows PowerShell:

```powershell
npm.cmd install
npm.cmd run check
npm.cmd start
```

No Linux/macOS:

```bash
npm install
npm run check
npm start
```

Para verificar o pacote:

```bash
npm run verify:package
```

## Comandos do bot

Os comandos abaixo são registrados como comandos slash (`/`). Quando um comando precisa de informações, o bot abre um **Modal** para preencher os dados.

### 👑 Dono

O cargo **Dono** possui acesso aos comandos administrativos e aos comandos exclusivos do proprietário.

| Comando | O que faz |
|---|---|
| `/publicar-verificacao` | Publica o painel de verificação. |
| `/criar-rifa` | Abre o formulário para criar uma rifa. |
| `/editar-rifa` | Abre o formulário para editar uma rifa. |
| `/gerenciar-rifa` | Pausa, reativa, encerra ou exclui uma rifa. |
| `/publicar-rifa` | Abre o formulário para publicar uma rifa. |
| `/numeros-rifa` | Consulta números disponíveis, reservados e vendidos. |
| `/criar-cupom` | Cria um cupom de desconto. |
| `/ativar-cupom` | Ativa um cupom. |
| `/desativar-cupom` | Desativa um cupom. |
| `/editar-cupom` | Edita as configurações de um cupom. |
| `/excluir-cupom` | Exclui um cupom. |
| `/cupom-usos` | Consulta os usos de um cupom. |
| `/sortear` | Abre o formulário para realizar o sorteio. |
| `/republicar-resultado` | Republica um resultado salvo. |
| `/punir` | Bloqueia um usuário das rifas. |
| `/remover-punicao` | Remove uma punição. |
| `/historico-punicoes` | Consulta o histórico de punições. |
| `/painel` | Mostra o painel administrativo. |
| `/aviso` | Abre o modal para enviar um aviso com título, texto e imagem. |
| `/configurar` | Abre a configuração do bot para o servidor. **Exclusivo do Dono.** |
| `/backup` | Gera um backup JSON do sistema. **Exclusivo do Dono.** |

### 🛡️ ADM

O cargo **ADM** possui acesso aos comandos administrativos. Os comandos `/configurar` e `/backup` são exclusivos do Dono.

| Comando | O que faz |
|---|---|
| `/publicar-verificacao` | Publica o painel de verificação. |
| `/criar-rifa` | Abre o formulário para criar uma rifa. |
| `/editar-rifa` | Abre o formulário para editar uma rifa. |
| `/gerenciar-rifa` | Pausa, reativa, encerra ou exclui uma rifa. |
| `/publicar-rifa` | Abre o formulário para publicar uma rifa. |
| `/numeros-rifa` | Consulta números disponíveis, reservados e vendidos. |
| `/criar-cupom` | Cria um cupom de desconto. |
| `/ativar-cupom` | Ativa um cupom. |
| `/desativar-cupom` | Desativa um cupom. |
| `/editar-cupom` | Edita as configurações de um cupom. |
| `/excluir-cupom` | Exclui um cupom. |
| `/cupom-usos` | Consulta os usos de um cupom. |
| `/sortear` | Abre o formulário para realizar o sorteio. |
| `/republicar-resultado` | Republica um resultado salvo. |
| `/punir` | Bloqueia um usuário das rifas. |
| `/remover-punicao` | Remove uma punição. |
| `/historico-punicoes` | Consulta o histórico de punições. |
| `/painel` | Mostra o painel administrativo. |
| `/aviso` | Abre o modal para enviar um aviso com título, texto e imagem. |

### 👤 Comandos gerais

Estes comandos não exigem cargo de Dono/ADM e são destinados às funções de consulta do usuário: 

| Comando | O que faz |
|---|---|
| `/ranking` | Abre o ranking geral ou de uma rifa. |
| `/perfil` | Mostra o perfil do usuário. |
| `/minhas-compras` | Mostra as compras recentes do próprio usuário. |
| `/status-bot` | Testa a conexão do bot e do Supabase. |

> **Permissões:** o sistema considera o usuário como Dono quando ele possui o cargo definido em `OWNER_ROLE_ID`. O Dono também passa pela verificação de ADM, portanto possui os comandos de ADM. O cargo ADM é definido por `ADMIN_ROLE_ID`.

## Cupons

Os eventos de cupom podem ser enviados para um canal exclusivo usando:

```env
COUPON_LOG_CHANNEL_ID=ID_DO_CANAL
```

Os registros incluem eventos como criação, edição, ativação, desativação e exclusão, conforme a ação realizada.

### Permissões

As funções administrativas utilizam os cargos configurados em:

```env
OWNER_ROLE_ID=...
ADMIN_ROLE_ID=...
```

A configuração de permissões deve ser feita pelo administrador do servidor.

## Segurança

Este repositório foi preparado sem credenciais reais.

**Nunca publique:**

- `DISCORD_TOKEN`;
- `SUPABASE_SECRET_KEY`;
- arquivos `.env`;
- tokens, senhas ou chaves privadas;
- IDs privados se você não quiser expô-los no repositório.

O `.gitignore` já impede o envio do `.env` para o Git.

## Aviso sobre o projeto

Este projeto é disponibilizado para fins de **estudo, aprendizado e demonstração técnica**. Antes de utilizar um sistema de rifas em produção, verifique as regras da plataforma, a legislação aplicável e os requisitos do seu caso de uso.

## IA no desenvolvimento

Este projeto foi desenvolvido com **apoio de Inteligência Artificial** durante o processo de estudo. A IA foi utilizada como ferramenta auxiliar para geração e revisão de código, identificação de erros, organização do projeto, documentação e implementação de funcionalidades.

O objetivo é demonstrar como ferramentas de IA podem ser utilizadas como apoio ao aprendizado e ao desenvolvimento de software, mantendo o projeto como material de estudo.

## Versão

**LGC Win v1.1.7**

Projeto de estudo/conclusão desenvolvido com TypeScript, Discord.js e Supabase, com auxílio de IA.


- ## Link: Links

- [GitHub](https://github.com/IBrunooDev)
- [LinkedIn](https://www.linkedin.com/in/brunocarus/?originalSubdomain=br)
- [Instagram](https://www.instagram.com/IBrunooDev/)
---

Desenvolvido com :heart: por [IBrunooDev](https://github.com/IBrunooDev) 
© 2026 IBrunooDev. Todos os direitos reservados.

import dns from 'node:dns';
import { commands } from './commands.js';
import { config } from './config.js';

dns.setDefaultResultOrder('ipv4first');

type DiscordCommand = {
  id: string;
  name: string;
  description?: string;
  type?: number;
  options?: unknown[];
  default_member_permissions?: string | null;
  dm_permission?: boolean;
};

type DiscordApiError = Error & {
  status?: number;
  retryAfter?: number;
  code?: number;
};

const API = 'https://discord.com/api/v10';
const MAX_429_RETRIES = 8;

function assertNoSlashOptions() {
  const invalid = commands.filter((command: any) => Array.isArray(command.options) && command.options.length > 0);
  if (invalid.length > 0) {
    throw new Error(
      `Há comandos com campos na barra /: ${invalid.map((c: any) => c.name).join(', ')}. ` +
      'Todos os dados devem ser coletados por Modal.'
    );
  }
}

function normalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalize).sort().join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'id')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${normalize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameCommand(existing: DiscordCommand, desired: Record<string, unknown>): boolean {
  const existingComparable = {
    name: existing.name,
    description: existing.description,
    type: existing.type ?? 1,
    options: existing.options ?? [],
    default_member_permissions: existing.default_member_permissions ?? null,
    dm_permission: existing.dm_permission ?? true
  };
  const desiredComparable = {
    name: desired.name,
    description: desired.description,
    type: desired.type ?? 1,
    options: desired.options ?? [],
    default_member_permissions: desired.default_member_permissions ?? null,
    dm_permission: desired.dm_permission ?? true
  };
  return normalize(existingComparable) === normalize(desiredComparable);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function discordRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bot ${config.DISCORD_TOKEN}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {})
        },
        signal: controller.signal
      });

      const text = await response.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }

      if (response.ok) return data as T;

      const detail = typeof data === 'object' && data !== null
        ? JSON.stringify(data)
        : String(data ?? '');
      const apiData = typeof data === 'object' && data !== null
        ? data as { code?: unknown; retry_after?: unknown }
        : {};
      const retryBody = Number(apiData.retry_after);
      const retryHeader = Number(response.headers.get('retry-after'));
      const retryAfter = Math.max(
        Number.isFinite(retryBody) ? retryBody : 0,
        Number.isFinite(retryHeader) ? retryHeader : 0
      );

      const error: DiscordApiError = new Error(`Discord respondeu HTTP ${response.status}: ${detail}`);
      error.status = response.status;
      error.code = typeof apiData.code === 'number' ? apiData.code : undefined;
      error.retryAfter = retryAfter > 0 ? retryAfter : undefined;

      // 30034 é limite diário de criação de comandos. Esperar e repetir não resolve.
      if (response.status !== 429 || error.code === 30034 || attempt >= MAX_429_RETRIES) {
        throw error;
      }

      const waitSeconds = Math.min(Math.max(retryAfter, 1), 60);
      console.warn(
        `⏳ Discord aplicou rate limit (429). Aguardando ${waitSeconds.toFixed(1)}s antes de continuar ` +
        `(tentativa ${attempt + 1}/${MAX_429_RETRIES}).`
      );
      await sleep(Math.ceil(waitSeconds * 1000) + 250);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Falha inesperada ao comunicar com o Discord.');
}

export async function syncSlashCommands() {
  assertNoSlashOptions();

  console.log(`🔎 Conferindo os ${commands.length} comandos do LGC Win no Discord...`);
  const route = `/applications/${config.DISCORD_CLIENT_ID}/guilds/${config.DISCORD_GUILD_ID}/commands`;
  const existing = await discordRequest<DiscordCommand[]>(route);
  const byName = new Map(existing.map(command => [command.name, command]));

  console.log(`📋 Discord informou ${existing.length} comando(s) já registrado(s).`);

  let unchanged = 0;
  let missing = 0;
  let changed = 0;

  for (const command of commands) {
    const payload = command as unknown as Record<string, unknown>;
    const name = String(payload.name);
    const old = byName.get(name);

    if (!old) {
      missing++;
      continue;
    }

    if (sameCommand(old, payload)) {
      unchanged++;
    } else {
      changed++;
    }
  }

  const desiredNames = new Set(commands.map(command => String((command as unknown as Record<string, unknown>).name)));
  const removed = existing.filter(command => !desiredNames.has(command.name)).length;

  if (missing === 0 && changed === 0 && removed === 0 && existing.length === commands.length) {
    console.log(`✅ Todos os ${commands.length} comandos já estão carregados e atualizados.`);
    return;
  }

  console.log(
    `🔄 Sincronização necessária: ${missing} faltando, ${changed} diferente(s), ${removed} antigo(s). ` +
    'Será feita uma única atualização em lote para carregar todos os comandos.'
  );

  // Usa o endpoint de bulk overwrite do servidor. IDs existentes são preservados
  // quando conhecidos; comandos faltantes são criados em uma única requisição.
  const payload = commands.map(command => {
    const desired = command as unknown as Record<string, unknown>;
    const old = byName.get(String(desired.name));
    return old ? { ...desired, id: old.id } : desired;
  });

  const result = await discordRequest<DiscordCommand[]>(route, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

  const loaded = Array.isArray(result) ? result.length : 0;
  console.log(`✅ Sincronização concluída: ${loaded}/${commands.length} comandos carregados no Discord.`);
}

import { randomUUID } from 'node:crypto';
import type { Attachment } from 'discord.js';
import { supabase } from './supabase.js';

const BUCKET = 'raffle-prizes';
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

async function ensurePrizeBucket() {
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (data) return;

  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    allowedMimeTypes: ALLOWED_MIME_TYPES,
    fileSizeLimit: MAX_FILE_SIZE
  });

  // Se duas ações criarem o bucket ao mesmo tempo, uma delas pode receber "already exists".
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`Não foi possível preparar o armazenamento da foto: ${error.message}`);
  }
}

export async function uploadPrizeImage(attachment: Attachment, guildId: string, userId: string) {
  const contentType = attachment.contentType?.split(';')[0]?.toLowerCase() ?? '';

  if (!ALLOWED_MIME_TYPES.includes(contentType)) {
    throw new Error('A foto do prêmio deve ser PNG, JPG, WEBP ou GIF.');
  }

  if (attachment.size > MAX_FILE_SIZE) {
    throw new Error('A foto do prêmio pode ter no máximo 20 MB.');
  }

  await ensurePrizeBucket();

  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error('Não consegui baixar a foto enviada pelo Discord. Tente novamente.');

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_FILE_SIZE) throw new Error('A foto do prêmio pode ter no máximo 20 MB.');

  const extension = EXTENSIONS[contentType] ?? 'img';
  const path = `${guildId}/${userId}/${Date.now()}-${randomUUID()}.${extension}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
    contentType,
    cacheControl: '3600',
    upsert: false
  });

  if (error) throw new Error(`Não foi possível salvar a foto do prêmio: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data.publicUrl) throw new Error('Não foi possível gerar o link público da foto do prêmio.');

  return data.publicUrl;
}

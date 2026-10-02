import type { GuildMember } from 'discord.js';
import { getCachedSettings } from './guild-settings.js';
import { supabase } from './supabase.js';

export type VerificationRoleResult = {
  verifiedAdded: boolean;
  verifiedRemoved: boolean;
  unverifiedAdded: boolean;
  unverifiedRemoved: boolean;
};

export async function applyVerificationRoles(
  member: GuildMember,
  verified: boolean,
  reason = 'Sincronização automática da verificação'
): Promise<VerificationRoleResult> {
  const settings = getCachedSettings(member.guild.id);
  const result: VerificationRoleResult = {
    verifiedAdded: false,
    verifiedRemoved: false,
    unverifiedAdded: false,
    unverifiedRemoved: false
  };

  if (verified) {
    if (!member.roles.cache.has(settings.verified_role_id)) {
      await member.roles.add(settings.verified_role_id, reason);
      result.verifiedAdded = true;
    }
    if (member.roles.cache.has(settings.unverified_role_id)) {
      await member.roles.remove(settings.unverified_role_id, reason);
      result.unverifiedRemoved = true;
    }
  } else {
    // O LGC Win NÃO adiciona o cargo "Membro não verificado".
    // Esse cargo pode ser entregue por outro bot (ex.: Loritta). Aqui apenas
    // removemos um cargo Verificado indevido quando for necessário sincronizar.
    if (member.roles.cache.has(settings.verified_role_id)) {
      await member.roles.remove(settings.verified_role_id, reason);
      result.verifiedRemoved = true;
    }
  }

  return result;
}

export async function syncMemberVerificationState(member: GuildMember, reason?: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('verified')
    .eq('discord_id', member.id)
    .maybeSingle();
  if (error) throw error;
  const verified = Boolean(data?.verified);
  const roles = await applyVerificationRoles(member, verified, reason);
  return { verified, roles };
}

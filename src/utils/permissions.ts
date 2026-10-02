import type { GuildMember } from 'discord.js';
import { getCachedSettings } from '../services/guild-settings.js';

export function isOwner(member: GuildMember) {
  const settings = getCachedSettings(member.guild.id);
  return member.roles.cache.has(settings.owner_role_id);
}

export function isAdmin(member: GuildMember) {
  const settings = getCachedSettings(member.guild.id);
  return isOwner(member) || member.roles.cache.has(settings.admin_role_id);
}

export function isVerified(member: GuildMember) {
  const settings = getCachedSettings(member.guild.id);
  return member.roles.cache.has(settings.verified_role_id);
}

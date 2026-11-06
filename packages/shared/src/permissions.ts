/**
 * Permission and hierarchy helpers.
 * These are pure functions so they can be unit tested without a Discord gateway.
 */

export interface HierarchyMember {
  id: string;
  highestRolePosition: number;
  isOwner: boolean;
}

export interface HierarchyGuild {
  ownerId: string | null;
  /** Position of the bot's highest role. */
  botPosition: number;
}

export type ModerationDenial =
  | 'self'
  | 'owner'
  | 'target_higher'
  | 'equal_position'
  | 'bot_higher'
  | 'bot_lower'
  | 'missing_permission';

export interface HierarchyCheck {
  allowed: boolean;
  reason?: ModerationDenial;
}

/**
 * Validate that a moderator may act on a target:
 * - cannot act on themselves
 * - cannot act on the guild owner
 * - actor must outrank the target
 * - bot must outrank the target (otherwise Discord rejects the action)
 */
export function canModerate(input: {
  guild: HierarchyGuild;
  actor: HierarchyMember;
  target: HierarchyMember;
  actorHasPermission: boolean;
}): HierarchyCheck {
  const { guild, actor, target, actorHasPermission } = input;
  if (!actorHasPermission) return { allowed: false, reason: 'missing_permission' };
  if (actor.id === target.id) return { allowed: false, reason: 'self' };
  if (target.isOwner || target.id === guild.ownerId) return { allowed: false, reason: 'owner' };
  if (actor.isOwner) return { allowed: true };
  if (actor.highestRolePosition <= target.highestRolePosition) {
    return {
      allowed: false,
      reason: actor.highestRolePosition === target.highestRolePosition ? 'equal_position' : 'target_higher',
    };
  }
  if (guild.botPosition <= target.highestRolePosition) return { allowed: false, reason: 'bot_lower' };
  return { allowed: true };
}

export const DENIAL_MESSAGES: Record<ModerationDenial, string> = {
  self: 'You cannot perform this action on yourself.',
  owner: 'The server owner cannot be moderated.',
  target_higher: 'That member has a higher role than you.',
  equal_position: 'That member has an equal highest role to yours, so Discord will reject the action.',
  bot_higher: 'That member outranks the bot.',
  bot_lower: "IRH CORE's role is below that member's highest role, so Discord will reject the action.",
  missing_permission: 'You do not have permission to do that.',
};

export function denialMessage(reason: ModerationDenial | undefined): string {
  return reason ? DENIAL_MESSAGES[reason] : 'Action denied.';
}

/** Dashboard access levels, highest first. */
export const ACCESS_ORDER = ['owner', 'admin', 'manage_guild', 'view'] as const;
export type AccessLevel = (typeof ACCESS_ORDER)[number];

export function hasAccess(level: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_ORDER.indexOf(level) <= ACCESS_ORDER.indexOf(required);
}

/** Discord permission bit for "Administrator". */
export const PERMISSION_ADMINISTRATOR = 1n << 3n;
export const PERMISSION_MANAGE_GUILD = 1n << 5n;

/**
 * Compute dashboard access for a guild given the user's permissions.
 * Owners and administrators can configure everything; MANAGE_GUILD can view
 * and configure community modules but not security-critical ones.
 */
export function resolveAccessLevel(input: {
  userId: string;
  guildOwnerId: string | null;
  permissions: string | bigint;
  botOwner?: boolean;
}): AccessLevel | null {
  if (input.botOwner) return 'owner';
  if (input.guildOwnerId && input.userId === input.guildOwnerId) return 'owner';
  const permissions = BigInt(input.permissions);
  if ((permissions & PERMISSION_ADMINISTRATOR) === PERMISSION_ADMINISTRATOR) return 'admin';
  if ((permissions & PERMISSION_MANAGE_GUILD) === PERMISSION_MANAGE_GUILD) return 'manage_guild';
  return null;
}

/** Modules that require at least `admin` (security-critical). */
export const ADMIN_ONLY_MODULES = new Set(['security', 'backups', 'integrations']);

export function canEditModule(level: AccessLevel, moduleId: string): boolean {
  if (moduleId === 'general' && level === 'view') return false;
  if (ADMIN_ONLY_MODULES.has(moduleId)) return hasAccess(level, 'admin');
  return hasAccess(level, 'manage_guild');
}

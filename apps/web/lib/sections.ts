/** Dashboard section registry — one entry per required page. */

export interface SectionDef {
  id: string;
  label: string;
  icon: string;
  group: string;
  description: string;
  module?: string;
  readOnly?: boolean;
  adminOnly?: boolean;
}

export const SECTIONS: SectionDef[] = [
  { id: 'overview', label: 'Overview', icon: '◈', group: 'Home', description: 'Server health, activity and quick configuration.' },
  { id: 'settings', label: 'Server Settings', icon: '⚙', group: 'Home', description: 'Identity, staff roles and global defaults.', module: 'general' },
  { id: 'moderation', label: 'Moderation', icon: '🛡', group: 'Moderation', description: 'Cases, warnings, notes, appeals and escalation.', module: 'moderation' },
  { id: 'automod', label: 'Auto Moderation', icon: '🚫', group: 'Moderation', description: 'Spam, caps, links, invites and keyword filters.', module: 'automod' },
  { id: 'security', label: 'Security', icon: '🔒', group: 'Moderation', description: 'Anti-nuke, anti-raid, alt detection and lockdown.', module: 'security' },
  { id: 'logging', label: 'Logging', icon: '📋', group: 'Insights', description: 'Route every event to one or more channels.' },
  { id: 'welcome', label: 'Welcome', icon: '✨', group: 'Community', description: 'Welcome, goodbye, DMs and generated images.', module: 'welcome' },
  { id: 'verification', label: 'Verification', icon: '✅', group: 'Community', description: 'Button, captcha and rules verification.', module: 'verification' },
  { id: 'autoroles', label: 'Autoroles', icon: '👥', group: 'Community', description: 'Roles on join, after verification and rejoin.', module: 'autoroles' },
  { id: 'reactionroles', label: 'Reaction Roles', icon: '😀', group: 'Community', description: 'Buttons, select menus and reactions.', module: 'reactionroles' },
  { id: 'tickets', label: 'Tickets', icon: '🎫', group: 'Community', description: 'Support panels, transcripts and feedback.', module: 'tickets' },
  { id: 'voicemaster', label: 'Voice Master', icon: '🎙', group: 'Community', description: 'Join-to-create temporary voice channels.', module: 'voicemaster' },
  { id: 'leveling', label: 'Leveling', icon: '🏆', group: 'Engagement', description: 'XP, levels, rank cards and role rewards.', module: 'leveling' },
  { id: 'statistics', label: 'Statistics', icon: '📈', group: 'Insights', description: 'Growth charts, activity and counter channels.', module: 'statistics' },
  { id: 'giveaways', label: 'Giveaways', icon: '🎉', group: 'Engagement', description: 'Persistent giveaways with requirements.', module: 'giveaways' },
  { id: 'invites', label: 'Invite Tracking', icon: '📨', group: 'Engagement', description: 'Attribution, fakes, leaderboard and rewards.', module: 'invites' },
  { id: 'rss', label: 'Feeds (RSS)', icon: '📡', group: 'Automation', description: 'RSS, YouTube and Reddit feeds with dedupe.', module: 'rss' },
  { id: 'announcements', label: 'Announcements', icon: '📣', group: 'Automation', description: 'Scheduled and recurring announcements.', module: 'announcements' },
  { id: 'emojis', label: 'Emoji Manager', icon: '😄', group: 'Engagement', description: 'Sync, export and manage emojis and stickers.', module: 'emojis' },
  { id: 'autoreactions', label: 'Auto Reactions', icon: '❤', group: 'Automation', description: 'Keyword, regex and catch-all reactions.', module: 'autoreactions' },
  { id: 'customcommands', label: 'Custom Commands', icon: '⌨', group: 'Automation', description: 'Prefix commands and auto responders.', module: 'customcommands' },
  { id: 'automations', label: 'Automations', icon: '⚡', group: 'Automation', description: 'Trigger → condition → action workflows.', module: 'automations' },
  { id: 'integrations', label: 'Integrations', icon: '🔌', group: 'System', description: 'YouTube, Twitch, webhooks and API keys.', module: 'integrations', adminOnly: true },
  { id: 'audit', label: 'Audit History', icon: '🧾', group: 'Insights', description: 'Every configuration and moderation change.' },
  { id: 'backups', label: 'Backups', icon: '💾', group: 'System', description: 'Snapshot and restore server configuration.', module: 'backups', adminOnly: true },
  { id: 'status', label: 'Bot Status', icon: '🤖', group: 'System', description: 'Gateway, heartbeat and realtime status.' },
  { id: 'system', label: 'System Health', icon: '🩺', group: 'System', description: 'Database, queues, jobs and diagnostics.' },
];

export const SECTION_GROUPS = ['Home', 'Moderation', 'Community', 'Engagement', 'Automation', 'Insights', 'System'];

export function sectionById(id: string): SectionDef | undefined {
  return SECTIONS.find((section) => section.id === id);
}

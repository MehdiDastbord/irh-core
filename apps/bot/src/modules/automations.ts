/** Automation workflows: trigger → conditions → actions. */

import type { Guild, GuildMember, Message } from 'discord.js';
import { logger, prisma, requireGuildId, getModuleSettings } from '@irh/db';
import { renderTemplate } from '@irh/shared';
import { emitLog } from '../lib/logging.js';

const log = logger.child('automations');

export interface WorkflowCondition {
  field: string;
  operator: 'equals' | 'contains' | 'greater' | 'less' | 'has_role';
  value: string;
}

export interface WorkflowAction {
  type: 'add_role' | 'remove_role' | 'send_message' | 'dm_user' | 'delete_message' | 'log' | 'timeout';
  value?: string;
  durationMs?: number;
}

export interface WorkflowContext {
  guild: Guild;
  member?: GuildMember | null;
  message?: Message | null;
  extra?: Record<string, string | number | boolean | null | undefined>;
}

/** Pure condition evaluation for unit tests. */
export function conditionsMatch(conditions: WorkflowCondition[], context: Record<string, unknown>): boolean {
  for (const condition of conditions) {
    const actual = context[condition.field];
    switch (condition.operator) {
      case 'equals':
        if (String(actual ?? '') !== condition.value) return false;
        break;
      case 'contains':
        if (!String(actual ?? '').toLowerCase().includes(condition.value.toLowerCase())) return false;
        break;
      case 'greater':
        if (Number(actual ?? 0) <= Number(condition.value)) return false;
        break;
      case 'less':
        if (Number(actual ?? 0) >= Number(condition.value)) return false;
        break;
      case 'has_role': {
        const roles = (actual as string[] | undefined) ?? [];
        if (!roles.includes(condition.value)) return false;
        break;
      }
    }
  }
  return true;
}

function buildContext(context: WorkflowContext): Record<string, unknown> {
  return {
    userId: context.member?.id ?? context.message?.author.id ?? null,
    username: context.member?.user.username ?? context.message?.author.username ?? null,
    accountAgeDays: context.member ? Math.floor((Date.now() - context.member.user.createdTimestamp) / 86_400_000) : 0,
    roles: context.member ? [...context.member.roles.cache.keys()] : [],
    content: context.message?.content ?? '',
    channelId: context.message?.channelId ?? null,
    ...context.extra,
  };
}

export async function runWorkflows(trigger: string, context: WorkflowContext): Promise<number> {
  const internalId = await requireGuildId(context.guild.id);
  const settings = await getModuleSettings<{ enabled: boolean; dryRun: boolean; logChannelId: string | null }>(internalId, 'automations');
  if (!settings.enabled) return 0;
  const workflows = await prisma.automationWorkflow.findMany({ where: { guildId: internalId, trigger, enabled: true } });
  let executed = 0;
  const values = buildContext(context);

  for (const workflow of workflows) {
    if (!conditionsMatch((workflow.conditions as unknown as WorkflowCondition[]) ?? [], values)) continue;
    const actions = (workflow.actions as unknown as WorkflowAction[]) ?? [];
    try {
      if (!settings.dryRun) {
        for (const action of actions) {
          const rendered = action.value ? renderTemplate(action.value, { user: context.member ? `<@${context.member.id}>` : '', server: context.guild.name, memberCount: context.guild.memberCount }) : '';
          switch (action.type) {
            case 'add_role':
              if (context.member && rendered) await context.member.roles.add(rendered, `Automation: ${workflow.name}`);
              break;
            case 'remove_role':
              if (context.member && rendered) await context.member.roles.remove(rendered, `Automation: ${workflow.name}`);
              break;
            case 'send_message': {
              const channelId = (values.channelId as string | null) ?? settings.logChannelId;
              if (channelId && rendered) {
                const channel = await context.guild.channels.fetch(channelId).catch(() => null);
                if (channel?.isTextBased() && 'send' in channel) await channel.send({ content: rendered, allowedMentions: { parse: [] } });
              }
              break;
            }
            case 'dm_user':
              if (context.member && rendered) await context.member.send({ content: rendered }).catch(() => undefined);
              break;
            case 'delete_message':
              await context.message?.delete().catch(() => undefined);
              break;
            case 'timeout':
              if (context.member) await context.member.timeout(action.durationMs ?? 600_000, `Automation: ${workflow.name}`).catch(() => undefined);
              break;
            case 'log':
            default:
              break;
          }
        }
      }
      await prisma.automationWorkflow.update({
        where: { id: workflow.id },
        data: { runCount: { increment: 1 }, lastRunAt: new Date(), lastError: null },
      });
      executed += 1;
      await emitLog({
        guild: context.guild,
        event: 'system.error',
        summary: `Automation **${workflow.name}** executed ${actions.length} action(s)${settings.dryRun ? ' (dry run)' : ''}`,
        targetId: context.member?.id ?? null,
        channelId: values.channelId as string | null,
        bypassIgnore: true,
      }).catch(() => undefined);
    } catch (error) {
      log.warn('Workflow execution failed', { workflowId: workflow.id, error: String(error) });
      await prisma.automationWorkflow.update({ where: { id: workflow.id }, data: { lastError: String(error).slice(0, 300) } }).catch(() => undefined);
    }
  }
  return executed;
}

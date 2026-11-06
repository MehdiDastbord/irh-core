/** Ticket persistence, numbering, transcripts and statistics. */

import { prisma } from './client.js';
import { logger } from './logger.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface TranscriptMessage {
  authorId: string;
  authorTag: string;
  content: string;
  createdAt: Date;
  attachments?: string[];
}

/** Render a self-contained HTML transcript (no external assets). */
export function buildTranscript(input: {
  guildName: string;
  ticketNumber: number;
  subject: string;
  openedBy: string;
  closedBy?: string | null;
  messages: TranscriptMessage[];
  generatedAt?: Date;
}): string {
  const rows = input.messages
    .map(
      (message) => `
      <article class="msg">
        <header>
          <span class="author">${escapeHtml(message.authorTag)}</span>
          <span class="uid">${escapeHtml(message.authorId)}</span>
          <time>${message.createdAt.toISOString().replace('T', ' ').slice(0, 19)} UTC</time>
        </header>
        <div class="body">${escapeHtml(message.content).replace(/\n/g, '<br />')}</div>
        ${
          message.attachments && message.attachments.length
            ? `<ul class="attachments">${message.attachments
                .map((url) => `<li><a href="${escapeHtml(url)}" rel="noreferrer noopener">${escapeHtml(url)}</a></li>`)
                .join('')}</ul>`
            : ''
        }
      </article>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ticket #${input.ticketNumber} — ${escapeHtml(input.guildName)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px; background:#070a15; color:#e6e9f5; font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .meta { color:#8b93b0; font-size: 13px; margin-bottom: 24px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; background:#16203c; color:#9ab3ff; font-size:12px; }
  .msg { border:1px solid #1b2440; border-radius:12px; padding:14px 16px; margin-bottom:12px; background:#0c1226; }
  .msg header { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; margin-bottom:6px; }
  .author { font-weight:600; color:#c9d4ff; }
  .uid, time { color:#6d7695; font-size:12px; }
  .body { white-space:pre-wrap; word-break:break-word; }
  .attachments { margin:8px 0 0; padding-left:18px; font-size:13px; }
  a { color:#7ea6ff; }
  footer { margin-top:24px; color:#5d6684; font-size:12px; text-align:center; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Ticket #${input.ticketNumber} — ${escapeHtml(input.subject)}</h1>
    <p class="meta">
      <span class="pill">${escapeHtml(input.guildName)}</span>
      Opened by ${escapeHtml(input.openedBy)}
      ${input.closedBy ? ` · Closed by ${escapeHtml(input.closedBy)}` : ''}
      · ${input.messages.length} messages
    </p>
    ${rows || '<p class="meta">No messages recorded.</p>'}
    <footer>Generated ${(input.generatedAt ?? new Date()).toISOString()} · IRH CORE</footer>
  </div>
</body>
</html>`;
}

export async function nextTicketNumber(guildId: string): Promise<number> {
  const aggregate = await prisma.ticket.aggregate({ where: { guildId }, _max: { number: true } });
  return (aggregate._max.number ?? 0) + 1;
}

export async function createTicket(input: {
  guildId: string;
  channelId: string;
  userId: string;
  username?: string | null;
  subject: string;
  panelId?: string | null;
  priority?: string;
  formData?: unknown;
  assignedToIds?: string[];
}) {
  const number = await nextTicketNumber(input.guildId);
  return prisma.ticket.create({
    data: {
      guildId: input.guildId,
      number,
      channelId: input.channelId,
      userId: input.userId,
      username: input.username ?? null,
      subject: input.subject,
      panelId: input.panelId ?? null,
      priority: input.priority ?? 'normal',
      formData: (input.formData ?? undefined) as never,
      assignedToIds: (input.assignedToIds ?? []) as never,
    },
  });
}

export async function findTicketByChannel(channelId: string) {
  return prisma.ticket.findUnique({ where: { channelId }, include: { messages: false } });
}

export async function openTicketCount(guildId: string, userId: string): Promise<number> {
  return prisma.ticket.count({ where: { guildId, userId, status: { in: ['open', 'claimed'] } } });
}

export async function recordTicketMessage(ticketId: string, message: {
  authorId: string;
  authorTag?: string | null;
  content: string;
  attachments?: string[];
}) {
  await prisma.$transaction([
    prisma.ticketMessage.create({
      data: {
        ticketId,
        authorId: message.authorId,
        authorTag: message.authorTag ?? null,
        content: message.content.slice(0, 4000),
        attachments: (message.attachments ?? []) as never,
      },
    }),
    prisma.ticket.update({ where: { id: ticketId }, data: { lastActivityAt: new Date() } }),
  ]);
}

export async function closeTicketRecord(input: {
  ticketId: string;
  closedById: string;
  reason?: string | null;
  html?: string;
  messageCount?: number;
}) {
  return prisma.ticket.update({
    where: { id: input.ticketId },
    data: {
      status: 'closed',
      closedAt: new Date(),
      closedById: input.closedById,
      closeReason: input.reason ?? null,
    },
  });
}

export async function saveTranscript(input: {
  ticketId: string;
  guildId: string;
  html: string;
  messageCount: number;
  createdById?: string | null;
}) {
  const existing = await prisma.ticketTranscript.findFirst({ where: { ticketId: input.ticketId } });
  if (existing) {
    return prisma.ticketTranscript.update({
      where: { id: existing.id },
      data: { html: input.html, messageCount: input.messageCount },
    });
  }
  return prisma.ticketTranscript.create({
    data: {
      ticketId: input.ticketId,
      guildId: input.guildId,
      html: input.html,
      messageCount: input.messageCount,
      createdById: input.createdById ?? null,
    },
  });
}

export function ticketNaming(template: string, vars: { number: number; username: string; panel: string }): string {
  const sanitize = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 90) || 'ticket';
  return sanitize(
    (template || 'ticket-{number}')
      .replace(/\{number\}/g, String(vars.number))
      .replace(/\{username\}/g, vars.username)
      .replace(/\{panel\}/g, vars.panel),
  );
}

export async function ticketStats(guildId: string) {
  const [open, closed, ratings, byPriority] = await Promise.all([
    prisma.ticket.count({ where: { guildId, status: { in: ['open', 'claimed'] } } }),
    prisma.ticket.count({ where: { guildId, status: 'closed' } }),
    prisma.ticket.aggregate({ where: { guildId, rating: { not: null } }, _avg: { rating: true }, _count: { rating: true } }),
    prisma.ticket.groupBy({ by: ['priority'], where: { guildId }, _count: { _all: true } }),
  ]);
  return {
    open,
    closed,
    avgRating: ratings._avg.rating ? Number(ratings._avg.rating.toFixed(2)) : null,
    ratingCount: ratings._count.rating,
    byPriority: byPriority.map((row) => ({ priority: row.priority, count: row._count._all })),
  };
}

export async function inactiveTickets(guildId: string, hours: number) {
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  return prisma.ticket.findMany({
    where: { guildId, status: { in: ['open', 'claimed'] }, lastActivityAt: { lt: cutoff } },
    take: 25,
  });
}

export async function recordTicketFeedback(ticketId: string, rating: number, feedback?: string) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('Rating must be between 1 and 5');
  logger.info('tickets', 'Ticket feedback recorded', { ticketId, rating });
  return prisma.ticket.update({ where: { id: ticketId }, data: { rating, feedback: feedback?.slice(0, 1000) ?? null } });
}

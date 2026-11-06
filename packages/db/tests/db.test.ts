import { beforeAll, describe, expect, it } from 'vitest';
import { createBackup, decideEscalation, decryptSecret, encryptSecret, enqueueJob, getModuleSettings, hashToken, prisma, restoreBackup, saveModuleSettings, safeEqual, claimDueJobs, completeJob } from '../src/index.js';

let guildA: string;
let guildB: string;

beforeAll(async () => {
  const a = await prisma.guild.create({ data: { discordId: '900000000000000001', name: 'Alpha' } });
  const b = await prisma.guild.create({ data: { discordId: '900000000000000002', name: 'Beta' } });
  guildA = a.id;
  guildB = b.id;
});

describe('guild settings', () => {
  it('returns validated defaults for a fresh module', async () => {
    const settings = await getModuleSettings<Record<string, unknown>>(guildA, 'automod');
    expect(settings).toHaveProperty('enabled');
    expect(typeof settings.enabled).toBe('boolean');
  });

  it('persists and validates patches', async () => {
    const result = await saveModuleSettings(guildA, 'automod', { enabled: false, spamThreshold: 9 }, { actorId: '900000000000000009' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.enabled).toBe(false);
    expect(result.data.spamThreshold).toBe(9);
    const reread = await getModuleSettings<{ enabled: boolean; spamThreshold: number }>(guildA, 'automod');
    expect(reread.enabled).toBe(false);
    expect(reread.spamThreshold).toBe(9);
  });

  it('rejects invalid values without touching stored settings', async () => {
    const before = await getModuleSettings<{ enabled: boolean }>(guildA, 'automod');
    const result = await saveModuleSettings(guildA, 'automod', { enabled: 'not-a-boolean' }, { actorId: null });
    expect(result.ok).toBe(false);
    const after = await getModuleSettings<{ enabled: boolean }>(guildA, 'automod');
    expect(after.enabled).toBe(before.enabled);
  });

  it('isolates settings per guild', async () => {
    await saveModuleSettings(guildB, 'automod', { enabled: true, spamThreshold: 3 }, { actorId: null });
    const alpha = await getModuleSettings<{ spamThreshold: number }>(guildA, 'automod');
    const beta = await getModuleSettings<{ spamThreshold: number }>(guildB, 'automod');
    expect(alpha.spamThreshold).toBe(9);
    expect(beta.spamThreshold).toBe(3);
  });

  it('writes an audit record for settings changes', async () => {
    const record = await prisma.auditRecord.findFirst({ where: { guildId: guildA, action: { contains: 'settings' } }, orderBy: { createdAt: 'desc' } });
    expect(record).not.toBeNull();
  });
});

describe('moderation escalation', () => {
  const steps = [
    { warnings: 1, action: 'warn' as const },
    { warnings: 3, action: 'timeout' as const, durationMs: 600_000 },
    { warnings: 5, action: 'ban' as const },
  ];

  it('selects the highest threshold reached', () => {
    expect(decideEscalation(0, steps)).toBeNull();
    expect(decideEscalation(1, steps)?.action).toBe('warn');
    expect(decideEscalation(4, steps)?.action).toBe('timeout');
    expect(decideEscalation(12, steps)?.action).toBe('ban');
  });

  it('ignores malformed steps', () => {
    expect(decideEscalation(3, [])).toBeNull();
    expect(decideEscalation(3, [{ warnings: Number.NaN, action: 'warn' } as never])).toBeNull();
  });
});

describe('secret handling', () => {
  it('encrypts with a random IV and decrypts back', () => {
    const first = encryptSecret('bot-token-value');
    const second = encryptSecret('bot-token-value');
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe('bot-token-value');
    expect(first).not.toContain('bot-token-value');
  });

  it('rejects tampered payloads', () => {
    const encrypted = encryptSecret('value');
    const parts = encrypted.split('.');
    const tag = parts[1] ?? '';
    parts[1] = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('hashes session tokens and compares safely', () => {
    const hash = hashToken('session-token');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken('session-token')).toBe(hash);
    expect(safeEqual(hash, hash)).toBe(true);
    expect(safeEqual(hash, hashToken('other'))).toBe(false);
  });
});

describe('job queue', () => {
  it('deduplicates by key and claims once', async () => {
    const first = await enqueueJob({ type: 'test.echo', payload: { n: 1 }, dedupeKey: 'test:dedupe' });
    const second = await enqueueJob({ type: 'test.echo', payload: { n: 2 }, dedupeKey: 'test:dedupe' });
    expect(second.id).toBe(first.id);

    const claimed = await claimDueJobs(50, 'vitest');
    const job = claimed.find((entry) => entry.id === first.id);
    expect(job).toBeTruthy();
    const again = await claimDueJobs(50, 'vitest');
    expect(again.some((entry) => entry.id === first.id)).toBe(false);
    await completeJob(first.id);
    const completed = await prisma.scheduledJob.findUnique({ where: { id: first.id } });
    expect(completed?.status).toBe('completed');
  });

  it('does not claim jobs scheduled in the future', async () => {
    const job = await enqueueJob({ type: 'test.future', runAt: new Date(Date.now() + 3_600_000), dedupeKey: 'test:future' });
    const claimed = await claimDueJobs(50, 'vitest');
    expect(claimed.some((entry) => entry.id === job.id)).toBe(false);
    await prisma.scheduledJob.delete({ where: { id: job.id } });
  });
});

describe('backups', () => {
  it('creates a snapshot and restores it', async () => {
    await saveModuleSettings(guildB, 'welcome', { enabled: true, message: 'Welcome {user}!' }, { actorId: null });
    const backup = await createBackup({ guildId: guildB, name: 'vitest backup' });
    expect(backup.id).toBeTruthy();
    expect(backup.sizeBytes).toBeGreaterThan(0);

    const result = await restoreBackup({ guildId: guildB, backupId: backup.id });
    expect(result.restoredModules.length).toBeGreaterThan(0);
    const stored = await prisma.backup.findUnique({ where: { id: backup.id } });
    expect(stored?.restoredAt).toBeInstanceOf(Date);
  });

  it('refuses to restore another guild’s backup', async () => {
    const backup = await createBackup({ guildId: guildA, name: 'alpha only' });
    await expect(restoreBackup({ guildId: guildB, backupId: backup.id })).rejects.toThrow(/not found/i);
  });
});

import { describe, expect, it } from 'vitest';
import { renderWelcomeCard } from '../src/lib/image.js';
import { checkEligibility } from '../src/modules/giveaways.js';
import { buildLogEmbed } from '../src/lib/logging.js';

describe('welcome image renderer', () => {
  it('produces a valid PNG buffer', () => {
    const png = renderWelcomeCard({ username: 'Buffy', serverName: 'IRH CORE', memberCount: 1234 });
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.length).toBeGreaterThan(1000);
  });

  it('is deterministic for identical input', () => {
    const a = renderWelcomeCard({ username: 'Same', serverName: 'Server', memberCount: 5 });
    const b = renderWelcomeCard({ username: 'Same', serverName: 'Server', memberCount: 5 });
    expect(a.equals(b)).toBe(true);
  });
});

const base = {
  requiredRoleIds: [] as string[],
  memberRoleIds: ['role-a'],
  minAccountAgeDays: 0,
  accountCreatedAt: new Date(Date.now() - 365 * 86_400_000),
  minServerAgeDays: 0,
  joinedAt: new Date(Date.now() - 30 * 86_400_000),
  isBot: false,
};

describe('giveaway eligibility', () => {
  it('accepts an eligible member', () => {
    expect(checkEligibility(base).eligible).toBe(true);
  });

  it('rejects bots', () => {
    const result = checkEligibility({ ...base, isBot: true });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/bot/i);
  });

  it('requires configured roles', () => {
    const result = checkEligibility({ ...base, requiredRoleIds: ['role-b'] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/role/i);
  });

  it('enforces account age', () => {
    const result = checkEligibility({ ...base, minAccountAgeDays: 30, accountCreatedAt: new Date(Date.now() - 5 * 86_400_000) });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/account/i);
  });

  it('enforces server age', () => {
    const result = checkEligibility({ ...base, minServerAgeDays: 14, joinedAt: new Date(Date.now() - 2 * 86_400_000) });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/server/i);
  });
});

describe('log embeds', () => {
  it('includes executor, target and before/after fields', () => {
    const embed = buildLogEmbed({
      eventLabel: 'Member Banned',
      group: 'Punishments',
      summary: 'someone was banned',
      executorId: '111111111111111111',
      targetId: '222222222222222222',
      fields: [{ name: 'Reason', value: 'spam' }],
    });
    const json = embed.toJSON();
    expect(json.author?.name).toContain('Member Banned');
    expect(json.description).toBe('someone was banned');
    expect(json.fields?.some((field) => field.name === 'Reason')).toBe(true);
    expect(json.footer?.text).toBeTruthy();
  });

  it('truncates oversized summaries instead of failing', () => {
    const embed = buildLogEmbed({ eventLabel: 'Test', group: 'System', summary: 'x'.repeat(5000) });
    expect(embed.toJSON().description!.length).toBeLessThanOrEqual(4000);
  });
});

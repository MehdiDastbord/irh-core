import { z } from 'zod';
import type { FieldDef, ModuleDef } from './types.js';
import { MODULES, moduleById } from './modules.js';

/** Zod schema generated from a module's field descriptors. */
export function fieldSchema(field: FieldDef): z.ZodTypeAny {
  switch (field.type) {
    case 'boolean':
      return z.boolean();
    case 'number':
      return z
        .number()
        .refine((value) => Number.isFinite(value), 'must be a number')
        .refine((value) => field.min === undefined || value >= field.min, `must be at least ${field.min}`)
        .refine((value) => field.max === undefined || value <= field.max, `must be at most ${field.max}`);
    case 'channel':
    case 'role':
      return z
        .union([z.string().regex(/^\d{15,25}$/), z.literal(''), z.null()])
        .transform((value) => (value === '' ? null : value));
    case 'channels':
    case 'roles':
    case 'tags':
      return z
        .array(z.string().trim().min(1).max(200))
        .max(200)
        .transform((values) => Array.from(new Set(values.map((value) => value.trim()))).filter(Boolean));
    case 'color':
      return z.number().int().min(0).max(0xffffff);
    case 'duration':
      return z.number().int().min(0).max(1000 * 60 * 60 * 24 * 365);
    case 'select':
      return field.options?.length
        ? z.enum(field.options.map((option) => option.value) as [string, ...string[]])
        : z.string().max(200);
    case 'json':
      return z.any();
    case 'text':
    case 'textarea':
      return z.string().max(field.type === 'textarea' ? 4000 : 500);
    default:
      return z.string().max(2000);
  }
}

export function moduleSchema(module: ModuleDef): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of module.fields) shape[field.key] = fieldSchema(field);
  return z.object(shape).strict();
}

/** Defaults for a module (deep-cloned so callers cannot mutate the registry). */
export function moduleDefaults(moduleId: string): Record<string, unknown> {
  const module = moduleById(moduleId);
  if (!module) throw new Error(`Unknown module: ${moduleId}`);
  const out: Record<string, unknown> = {};
  for (const field of module.fields) out[field.key] = structuredClone(field.default ?? null);
  return out;
}

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: Record<string, string[]> };

/**
 * Merge stored data over defaults and validate it.
 * Unknown keys are dropped (stored data may outlive a field rename).
 */
export function validateModuleSettings(moduleId: string, raw: unknown): ValidationResult<Record<string, unknown>> {
  const module = moduleById(moduleId);
  if (!module) return { ok: false, errors: { module: [`Unknown module: ${moduleId}`] } };
  const defaults = moduleDefaults(moduleId);
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...defaults };
  for (const field of module.fields) {
    if (Object.prototype.hasOwnProperty.call(input, field.key)) merged[field.key] = input[field.key];
  }
  const parsed = moduleSchema(module).safeParse(merged);
  if (!parsed.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      (errors[key] ??= []).push(issue.message);
    }
    return { ok: false, errors };
  }
  return { ok: true, data: parsed.data as Record<string, unknown> };
}

/** Partial field update validation used by auto-save (only provided keys). */
export function validateModulePatch(moduleId: string, raw: unknown): ValidationResult<Record<string, unknown>> {
  const module = moduleById(moduleId);
  if (!module) return { ok: false, errors: { module: [`Unknown module: ${moduleId}`] } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: { _: ['Expected an object of settings'] } };
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = module.fields.find((candidate) => candidate.key === key);
    if (!field) continue;
    patch[key] = value;
  }
  const schema = moduleSchema(module).partial();
  const parsed = schema.safeParse(patch);
  if (!parsed.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      (errors[key] ??= []).push(issue.message);
    }
    return { ok: false, errors };
  }
  return { ok: true, data: parsed.data as Record<string, unknown> };
}

export const moduleIdSchema = z
  .string()
  .refine((value) => MODULES.some((module) => module.id === value), 'Unknown module');

export const snowflakeSchema = z.string().regex(/^\d{15,25}$/, 'Must be a Discord snowflake');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
});

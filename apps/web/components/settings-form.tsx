'use client';

import { moduleById } from '@irh/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useGuild } from './guild-context';
import { FieldInput } from './fields';
import { Alert, Badge, Button, Card, CardSkeleton, useToast } from './ui';

type Values = Record<string, unknown>;

export function SettingsForm({
  moduleId,
  readOnly = false,
  compact = false,
  fields: onlyFields,
}: {
  moduleId: string;
  readOnly?: boolean;
  compact?: boolean;
  fields?: string[];
}) {
  const module = moduleById(moduleId);
  const { guildId } = useGuild();
  const { push } = useToast();
  const [values, setValues] = useState<Values | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [query, setQuery] = useState('');
  const dirty = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<{ settings: Values }>(`/guilds/${guildId}/settings/${moduleId}`);
      setValues(data.settings);
      dirty.current.clear();
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Could not load settings');
    } finally {
      setLoading(false);
    }
  }, [guildId, moduleId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!values || dirty.current.size === 0 || readOnly) return;
    const patch: Values = {};
    for (const key of dirty.current) patch[key] = values[key];
    setSaving(true);
    try {
      const result = await api<{ settings: Values }>(`/guilds/${guildId}/settings/${moduleId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setValues(result.settings);
      setErrors({});
      dirty.current.clear();
      setSavedAt(new Date());
    } catch (cause) {
      const details = (cause as { details?: Record<string, string[]> }).details;
      if (details && typeof details === 'object') setErrors(details as Record<string, string[]>);
      push(cause instanceof Error ? cause.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }, [guildId, moduleId, push, readOnly, values]);

  const update = (key: string, value: unknown) => {
    setValues((current) => (current ? { ...current, [key]: value } : current));
    dirty.current.add(key);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 700);
  };

  const groups = useMemo(() => {
    if (!module) return [];
    const filtered = module.fields.filter((field) => {
      if (onlyFields && !onlyFields.includes(field.key)) return false;
      if (!query.trim()) return true;
      const needle = query.toLowerCase();
      return field.label.toLowerCase().includes(needle) || field.key.toLowerCase().includes(needle);
    });
    const map = new Map<string, typeof filtered>();
    for (const field of filtered) {
      const group = field.group ?? 'General';
      map.set(group, [...(map.get(group) ?? []), field]);
    }
    return [...map.entries()];
  }, [module, onlyFields, query]);

  if (!module) return <Alert tone="error">Unknown module: {moduleId}</Alert>;
  if (loadError) return <Alert tone="error">{loadError}</Alert>;
  if (loading || !values) return <CardSkeleton rows={6} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={readOnly ? 'warning' : 'info'}>{readOnly ? 'Read only' : 'Auto-save'}</Badge>
          {saving ? <span className="text-xs text-brand-300">Saving…</span> : savedAt ? <span className="text-xs text-emerald-400">Saved</span> : null}
        </div>
        {!compact ? (
          <input
            className="input max-w-xs"
            placeholder="Search settings…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search settings"
          />
        ) : null}
      </div>

      {Object.keys(errors).length ? (
        <Alert tone="error">Some values are invalid: {Object.keys(errors).join(', ')}</Alert>
      ) : null}

      {groups.map(([group, fields]) => (
        <Card key={group} className="card-pad animate-fadeIn">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">{group}</h3>
          <div className={group === 'General' ? 'space-y-5' : 'grid gap-5 md:grid-cols-2'}>
            {fields.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                value={values[field.key]}
                disabled={readOnly}
                error={errors[field.key]}
                onChange={(value) => update(field.key, value)}
              />
            ))}
          </div>
        </Card>
      ))}

      {!readOnly ? (
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} loading={saving}>
            Save now
          </Button>
          <Button variant="secondary" onClick={() => void load()} disabled={saving}>
            Reset changes
          </Button>
        </div>
      ) : null}
    </div>
  );
}

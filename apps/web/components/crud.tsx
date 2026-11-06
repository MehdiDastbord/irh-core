'use client';

import type { FieldDef } from '@irh/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, formatDate } from '@/lib/api';
import { useGuild } from './guild-context';
import { FieldInput } from './fields';
import { Alert, Button, Card, CardSkeleton, EmptyState, Modal, useToast } from './ui';

export type CrudField = Omit<FieldDef, 'default'> & { default?: unknown; required?: boolean };

export interface CrudColumn {
  key: string;
  label: string;
  render?: (item: Record<string, unknown>) => React.ReactNode;
}

export function CrudManager({
  title,
  description,
  path,
  fields,
  columns,
  createLabel = 'Create',
  itemKey = 'items',
  allowDelete = true,
  allowCreate = true,
  rowActions,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  onChanged,
}: {
  title: string;
  description?: string;
  path: string;
  fields: CrudField[];
  columns: CrudColumn[];
  createLabel?: string;
  itemKey?: string;
  allowDelete?: boolean;
  allowCreate?: boolean;
  rowActions?: (item: Record<string, unknown>, reload: () => void) => React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  onChanged?: () => void;
}) {
  const { guildId } = useGuild();
  const { push } = useToast();
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const resolvedPath = path.replace('{guildId}', guildId);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<Record<string, unknown>>(resolvedPath);
      setItems(Array.isArray(data[itemKey]) ? (data[itemKey] as Record<string, unknown>[]) : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load data');
      setItems([]);
    }
  }, [resolvedPath, itemKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    const initial: Record<string, unknown> = {};
    for (const field of fields) initial[field.key] = field.default ?? (field.type === 'boolean' ? false : field.type === 'number' ? 1 : field.type === 'tags' || field.type === 'roles' || field.type === 'channels' ? [] : '');
    setValues(initial);
    setFormError(null);
    setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    setFormError(null);
    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.key];
      if (field.required && (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0))) {
        setFormError(`${field.label} is required.`);
        setBusy(false);
        return;
      }
      if (value !== undefined) payload[field.key] = value;
    }
    try {
      await api(resolvedPath, { method: 'POST', body: JSON.stringify(payload) });
      push(`${title} created`, 'success');
      setOpen(false);
      await load();
      onChanged?.();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: Record<string, unknown>) => {
    if (!window.confirm('Delete this entry? This cannot be undone.')) return;
    try {
      await api(`${resolvedPath}/${String(item.id)}`, { method: 'DELETE' });
      push('Deleted', 'success');
      await load();
      onChanged?.();
    } catch (cause) {
      push(cause instanceof Error ? cause.message : 'Delete failed', 'error');
    }
  };

  return (
    <Card className="card-pad">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {description ? <p className="mt-1 text-sm text-slate-400">{description}</p> : null}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
          {allowCreate ? <Button onClick={openCreate}>{createLabel}</Button> : null}
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {items === null ? (
        <CardSkeleton rows={3} />
      ) : items.length === 0 ? (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          action={allowCreate ? <Button onClick={openCreate}>{createLabel}</Button> : undefined}
        />
      ) : (
        <div className="table-wrap">
          <table className="w-full">
            <thead className="bg-white/[0.02]">
              <tr>
                {columns.map((column) => (
                  <th key={column.key} className="th">
                    {column.label}
                  </th>
                ))}
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={String(item.id)} className="row">
                  {columns.map((column) => (
                    <td key={column.key} className="td">
                      {column.render
                        ? column.render(item)
                        : item[column.key] === null || item[column.key] === undefined
                          ? '—'
                          : typeof item[column.key] === 'object'
                            ? <code className="text-xs text-slate-400">{JSON.stringify(item[column.key]).slice(0, 60)}</code>
                            : String(item[column.key])}
                    </td>
                  ))}
                  <td className="td text-right">
                    <div className="flex items-center justify-end gap-2">
                      {rowActions?.(item, () => void load())}
                      {allowDelete ? (
                        <Button variant="danger" className="px-2.5 py-1.5 text-xs" onClick={() => void remove(item)}>
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={open} title={createLabel} onClose={() => setOpen(false)}>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {fields.map((field) => (
            <FieldInput
              key={field.key}
              field={{ ...field, default: undefined } as FieldDef}
              value={values[field.key]}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
            />
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            {createLabel}
          </Button>
        </div>
      </Modal>
    </Card>
  );
}

export function KeyValueTable({ items, columns }: { items: Record<string, unknown>[]; columns: CrudColumn[] }) {
  if (!items.length) return <EmptyState title="No records" />;
  return (
    <div className="table-wrap">
      <table className="w-full">
        <thead className="bg-white/[0.02]">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className="th">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={String(item.id ?? index)} className="row">
              {columns.map((column) => (
                <td key={column.key} className="td">
                  {column.render ? column.render(item) : String(item[column.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DateCell({ value }: { value: unknown }) {
  return <span className="text-slate-400">{formatDate(value as string)}</span>;
}

'use client';

import type { FieldDef } from '@irh/shared';
import { channelLabel, roleLabel, useGuild } from './guild-context';

const CHANNEL_TYPES_BY_NAME: Record<string, number[]> = {
  text: [0, 5],
  voice: [2],
  category: [4],
  announcement: [5],
  forum: [15],
};

export function toHex(color: number | null | undefined): string {
  return `#${(color ?? 0x5865f2).toString(16).padStart(6, '0')}`;
}

function MultiPicker({
  values,
  options,
  onChange,
  emptyLabel,
}: {
  values: string[];
  options: { value: string; label: string; hint?: string }[];
  onChange: (next: string[]) => void;
  emptyLabel: string;
}) {
  const toggle = (value: string) => {
    onChange(values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]);
  };
  return (
    <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-ink-900/60 p-1.5">
      {options.length === 0 ? <p className="px-2 py-3 text-xs text-slate-500">{emptyLabel}</p> : null}
      {options.map((option) => {
        const active = values.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => toggle(option.value)}
            aria-pressed={active}
            className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition ${
              active ? 'bg-brand-500/15 text-brand-100' : 'text-slate-400 hover:bg-white/5'
            }`}
          >
            <span className="truncate">{option.label}</span>
            <span className={`text-[10px] ${active ? 'text-brand-300' : 'text-slate-600'}`}>{active ? '✓' : option.hint ?? ''}</span>
          </button>
        );
      })}
    </div>
  );
}

export function FieldInput({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  error?: string[];
}) {
  const { channels, roles, loading } = useGuild();

  const filteredChannels = channels.filter((channel) => {
    if (!field.channelTypes?.length) return channel.type !== 4 && channel.type !== 2;
    const allowed = field.channelTypes.flatMap((type) => CHANNEL_TYPES_BY_NAME[type] ?? []);
    return allowed.includes(channel.type);
  });

  const common = { id: `field-${field.key}`, disabled, 'aria-invalid': Boolean(error?.length), 'aria-describedby': error?.length ? `err-${field.key}` : undefined };

  let control: React.ReactNode;
  switch (field.type) {
    case 'boolean':
      control = (
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(value)}
          onClick={() => onChange(!value)}
          disabled={disabled}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${value ? 'bg-brand-gradient' : 'bg-ink-700'} ${disabled ? 'opacity-50' : ''}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${value ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      );
      break;
    case 'number':
      control = (
        <input
          {...common}
          type="number"
          className="input max-w-[200px]"
          value={value === null || value === undefined ? '' : Number(value)}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
        />
      );
      break;
    case 'textarea':
    case 'json':
      control = (
        <textarea
          {...common}
          className="input min-h-[96px] font-mono text-[12px] leading-relaxed"
          value={field.type === 'json' ? JSON.stringify(value ?? null, null, 2) : String(value ?? '')}
          placeholder={field.placeholder}
          onChange={(event) => {
            if (field.type === 'json') {
              try {
                onChange(JSON.parse(event.target.value || 'null'));
              } catch {
                /* keep last valid value while typing */
              }
            } else onChange(event.target.value);
          }}
        />
      );
      break;
    case 'select':
      control = (
        <select {...common} className="input" value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'channel':
      control = (
        <select {...common} className="input" value={String(value ?? '')} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">{loading ? 'Loading channels…' : '— None —'}</option>
          {filteredChannels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channelLabel(channel)}
            </option>
          ))}
        </select>
      );
      break;
    case 'channels':
      control = (
        <MultiPicker
          values={(value as string[]) ?? []}
          options={filteredChannels.map((channel) => ({ value: channel.id, label: channelLabel(channel) }))}
          onChange={onChange}
          emptyLabel={loading ? 'Loading channels…' : 'No matching channels. Invite the bot first.'}
        />
      );
      break;
    case 'role':
      control = (
        <select {...common} className="input" value={String(value ?? '')} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">{loading ? 'Loading roles…' : '— None —'}</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {roleLabel(role)}
            </option>
          ))}
        </select>
      );
      break;
    case 'roles':
      control = (
        <MultiPicker
          values={(value as string[]) ?? []}
          options={roles.map((role) => ({ value: role.id, label: roleLabel(role) }))}
          onChange={onChange}
          emptyLabel={loading ? 'Loading roles…' : 'No roles available.'}
        />
      );
      break;
    case 'color':
      control = (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${field.label} colour`}
            disabled={disabled}
            value={toHex(Number(value))}
            onChange={(event) => onChange(Number.parseInt(event.target.value.slice(1), 16))}
            className="h-10 w-14 cursor-pointer rounded-lg border border-white/10 bg-transparent"
          />
          <input
            {...common}
            className="input max-w-[120px] font-mono text-xs"
            value={toHex(Number(value))}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value.replace('#', ''), 16);
              if (Number.isFinite(parsed)) onChange(parsed);
            }}
          />
        </div>
      );
      break;
    case 'duration':
      control = (
        <div className="flex items-center gap-2">
          <input
            {...common}
            type="number"
            className="input max-w-[160px]"
            min={0}
            value={Math.round((Number(value ?? 0) / 1000) * 100) / 100}
            onChange={(event) => onChange(Math.max(0, Math.round(Number(event.target.value || 0) * 1000)))}
          />
          <span className="text-xs text-slate-500">seconds</span>
        </div>
      );
      break;
    case 'tags':
      control = (
        <textarea
          {...common}
          className="input min-h-[64px] text-[13px]"
          placeholder="One per line or comma separated"
          value={Array.isArray(value) ? (value as string[]).join(', ') : ''}
          onChange={(event) =>
            onChange(
              event.target.value
                .split(/[,\n]/)
                .map((entry) => entry.trim())
                .filter(Boolean),
            )
          }
        />
      );
      break;
    default:
      control = (
        <input
          {...common}
          className="input"
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }

  return (
    <div className={field.type === 'boolean' ? 'flex items-start justify-between gap-4 py-2' : 'space-y-1.5'}>
      <div>
        <label htmlFor={`field-${field.key}`} className="label mb-0">
          {field.label}
        </label>
        {field.description ? <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-slate-500">{field.description}</p> : null}
      </div>
      <div className={field.type === 'boolean' ? '' : 'pt-1'}>{control}</div>
      {error?.length ? (
        <p id={`err-${field.key}`} role="alert" className="text-xs text-red-300">
          {error.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

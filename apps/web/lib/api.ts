'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1] ?? '') : null;
}

export async function api<T>(path: string, options: RequestInit & { raw?: boolean } = {}): Promise<T> {
  const csrf = readCookie('irh_csrf');
  const response = await fetch(`/api/irh${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-irh-csrf': csrf } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (response.status === 401) throw new ApiError('Your session expired. Please sign in again.', 401);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let details: unknown;
    try {
      const payload = (await response.json()) as { message?: string; details?: unknown; error?: string };
      message = payload.message ?? payload.error ?? message;
      details = payload.details;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(message, response.status, details);
  }
  if (response.status === 204) return undefined as T;
  if (options.raw) return (await response.text()) as unknown as T;
  return (await response.json()) as T;
}

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (value: T | null) => void;
}

export function useApi<T>(path: string | null, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    api<T>(path)
      .then((value) => {
        if (mounted.current) setData(value);
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(cause instanceof Error ? cause.message : 'Request failed');
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload, setData };
}

/** Subscribe to realtime dashboard events (WebSocket, ticket authenticated). */
export function useRealtime(onEvent: (event: { type: string; guildId?: string | null; payload?: unknown }) => void, enabled = true): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let attempts = 0;

    const connect = async () => {
      try {
        const { ticket } = await api<{ ticket: string }>('/me/ws-ticket', { method: 'POST' });
        const configured = process.env.NEXT_PUBLIC_WS_URL;
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = configured ? `${configured}?ticket=${encodeURIComponent(ticket)}` : `${protocol}://${window.location.hostname}:4000/ws?ticket=${encodeURIComponent(ticket)}`;
        socket = new WebSocket(url);
        socket.onopen = () => {
          attempts = 0;
          setConnected(true);
        };
        socket.onmessage = (message) => {
          try {
            const event = JSON.parse(String(message.data)) as { type: string };
            if (event.type === 'ping' || event.type === 'hello') return;
            handler.current(event);
          } catch {
            /* ignore malformed frames */
          }
        };
        socket.onclose = () => {
          setConnected(false);
          if (!closed) {
            attempts += 1;
            retry = setTimeout(connect, Math.min(15_000, 1_000 * 2 ** attempts));
          }
        };
        socket.onerror = () => socket?.close();
      } catch {
        if (!closed) {
          attempts += 1;
          retry = setTimeout(connect, Math.min(15_000, 1_000 * 2 ** attempts));
        }
      }
    };

    void connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [enabled]);

  return connected;
}

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-GB').format(value ?? 0);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  const diff = date.getTime() - Date.now();
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

type ApiOptions = RequestInit & {
  parseJson?: boolean;
  skipAuth?: boolean;
};

type ApiPayload = {
  message?: string;
  detail?: string;
  success?: boolean;
  [key: string]: unknown;
};

const API_TOKEN_STORAGE_KEY = 'bitget-desk-api-token';

class ApiClientError extends Error {
  status: number;
  payload: ApiPayload | null;

  constructor(message: string, status: number, payload: ApiPayload | null) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.payload = payload;
  }
}

function getBaseUrl() {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  return baseUrl ? baseUrl.replace(/\/$/, '') : '';
}

function buildUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getBaseUrl()}${normalizedPath}`;
}

function getStoredApiToken() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem(API_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getAuthHeaders(skipAuth?: boolean) {
  if (skipAuth) {
    return {};
  }

  const token = getStoredApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function safeJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function request<T>(url: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');

  const authHeaders = getAuthHeaders(options.skipAuth);
  Object.entries(authHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  const res = await fetch(buildUrl(url), {
    credentials: 'include',
    ...options,
    headers,
  });

  const payload = await safeJson(res);

  if (!res.ok) {
    throw new ApiClientError(payload?.message || `Request failed: ${res.status}`, res.status, payload);
  }

  return payload as T;
}

export const apiClient = {
  isAuthError: (error: unknown) =>
    error instanceof ApiClientError && (error.status === 401 || error.status === 403),
  getErrorMessage: (error: unknown, fallback: string) => {
    if (error instanceof ApiClientError) {
      return String(error.payload?.detail || error.payload?.message || fallback);
    }

    return fallback;
  },
  getApiBaseUrl: () => getBaseUrl(),
  getStoredApiToken: () => getStoredApiToken(),
  setApiToken: (token: string | null) => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      if (token) {
        window.localStorage.setItem(API_TOKEN_STORAGE_KEY, token);
      } else {
        window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
      }
    } catch {
      return;
    }
  },
  authMe: () => request<{ data?: { user: any; authType?: 'session' | 'api-token' } }>('/api/auth/me'),
  login: (identifier: string, password: string) =>
    request<{ data?: { user: any; authType?: 'session' | 'api-token' } }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
      skipAuth: true,
    }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  getPositions: (mode?: 'demo' | 'live') => request<any>(`/api/positions${mode ? `?mode=${mode}` : ''}`),
  getSettings: () => request<any>('/api/settings'),
  runMonitor: () => request<any>('/api/monitor'),
  updateSettings: (payload: Record<string, unknown>) =>
    request<any>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  openPosition: (payload: object) =>
    request<any>('/api/entry', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  closePosition: (id: number) =>
    request<any>('/api/close', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  emergencyClose: () =>
    request<any>('/api/emergency', {
      method: 'POST',
    }),
  clearHistory: (mode: 'demo' | 'live') =>
    request<any>(`/api/positions?mode=${mode}`, {
      method: 'DELETE',
    }),
  getApiTokens: () => request<{ data?: { tokens: any[] } }>('/api/auth/tokens'),
  createApiToken: (name: string) =>
    request<{ data?: { token: any } }>('/api/auth/tokens', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  revokeApiToken: (id: string) =>
    request(`/api/auth/tokens?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  getAuditLogs: (take = 30) => request<{ data?: { logs: any[] } }>(`/api/audit?take=${take}`),
  getAccountOverview: () => request<{ data?: any }>('/api/account-overview'),
  getStats: () => request<{ data?: any }>('/api/stats'),
  getBookmap: (symbol: string) => request<{ data?: any }>(`/api/bookmap?symbol=${encodeURIComponent(symbol)}`),
  getHeatmapPaper: () => request<{ data?: any }>('/api/heatmap-paper'),
  createHeatmapPaper: (payload: object) =>
    request<{ data?: any }>('/api/heatmap-paper', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getSounds: () => request<{ data?: { files: string[] } }>('/api/sounds'),
};

export type { ApiClientError };

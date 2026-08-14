/**
 * API Base URL configuration.
 *
 * URL API dipisahkan dari URL aplikasi agar frontend yang di-host secara statis
 * (Google Apps Script, Netlify, Vercel, dsb.) tetap bisa memanggil backend
 * melalui HTTPS.
 *
 * Priority:
 *  1. IPAW_BACKEND_URL / VITE_IPAW_BACKEND_URL — backend Netlify untuk
 *     frontend GAS.
 *  2. VITE_API_BASE_URL — API server aplikasi Replit untuk mode online biasa.
 *  2. String kosong      — URL relatif, bekerja di local dev (same origin)
 *
 * JANGAN gunakan window.location.origin sebagai base URL API.
 * Gunakan variabel ini sebagai satu-satunya sumber kebenaran.
 */

// Injected at build time by vite.config.ts `define`. True only on Replit
// (dev or production), where the shared Express proxy is available at /api/.
// On Netlify static builds the value is false — app calls GAS directly.
declare const __IS_REPLIT__: boolean;

declare global {
  // Injected only into the generated standalone ipaw.html. Keeping this
  // runtime override out of Vite env means normal online builds remain
  // configured exactly as before.
  var __IPAW_OFFLINE_API_BASE__: string | undefined;
  // Local PowerShell bridge used only by the offline Operating Theatre launcher.
  var __IPAW_OFFLINE_OT_PROXY_BASE__: string | undefined;
  // Set by ipawv3.html when the bundle is hosted by Google Apps Script.
  var __IPAW_GAS_HOSTED__: boolean | undefined;
  // Optional runtime override for the GAS deployment URL used by ipawv3.
  var __IPAW_GAS_API_URL__: string | undefined;
  // Netlify backend URL injected into the standalone GAS bundle.
  var __IPAW_BACKEND_URL__: string | undefined;
}

/**
 * The single default Google Apps Script Web App deployment URL.
 *
 * Keep this as the only source-level GAS URL. The user can still change the
 * active Cloud URL from Settings; direct GAS requests pass that value to
 * apiRequest() as an explicit base URL.
 */
export const GAS_API_URL =
  'https://script.google.com/macros/s/AKfycbzAnMrxuit5itGRjFMuHy94pEGFBnA_RVKowtQCRJX_OotdaKBwayy5Tuq8-s-K94QUdA/exec';

/**
 * Public URL of the Netlify Functions backend used by the GAS deployment.
 *
 * Set IPAW_BACKEND_URL when generating ipawv3.html. The placeholder is
 * intentional: it makes a missing deployment configuration explicit instead
 * of silently sending TrakCare data to the wrong server.
 */
export const IPAW_BACKEND_URL =
  ((import.meta.env.VITE_IPAW_BACKEND_URL as string | undefined) ??
    'https://ipawpkbackend.netlify.app').trim().replace(/\/$/, '');

/** Enable safe request/response diagnostics for GAS-hosted/offline builds. */
export const API_DEBUG = true;

const GAS_REQUEST_TIMEOUT_MS = 60_000;

export function isGasHosted(): boolean {
  return typeof globalThis !== 'undefined' && globalThis.__IPAW_GAS_HOSTED__ === true;
}

export interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
  debugLabel?: string;
}

export interface ApiRequestResult<T = unknown> {
  response: Response;
  data: T;
}

export interface IpawApiOptions {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
  timeoutMs?: number;
  debugLabel?: string;
  cache?: RequestCache;
}

/**
 * Single HTTPS client for the GAS → Netlify backend boundary.
 *
 * The helper deliberately accepts a structured body instead of making callers
 * stringify JSON themselves. This keeps timeout, JSON parsing, HTTP errors,
 * and diagnostics consistent across GET/POST/PUT/PATCH/DELETE requests.
 */
export async function ipawApi<T = unknown>(
  endpoint: string,
  options: IpawApiOptions = {},
): Promise<T> {
  const {
    method = 'GET',
    headers: inputHeaders,
    body,
    timeoutMs = 20_000,
    debugLabel = endpoint,
    cache = 'no-store',
  } = options;
  const normalizedMethod = method.toUpperCase();
  const base = isGasHosted() ? getIpawBackendUrl() : getApiBaseUrl();
  if (isGasHosted() && !base) {
    throw new Error('IPAW_BACKEND_URL belum dikonfigurasi.');
  }

  const target = isGasHosted()
    ? new URL(endpoint.startsWith('/') ? endpoint.slice(1) : endpoint, `${base}/`).toString()
    : apiUrl(endpoint);
  const headers = new Headers(inputHeaders);
  headers.set('Accept', headers.get('Accept') || 'application/json');
  let requestBody: BodyInit | undefined;
  if (body !== undefined && body !== null && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method: normalizedMethod,
      headers,
      body: requestBody,
      cache,
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload: any = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`Backend IPAW mengembalikan response bukan JSON (HTTP ${response.status}).`);
    }
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || `Backend IPAW merespons HTTP ${response.status}.`);
    }
    if (API_DEBUG) {
      console.log(`[IPAW API][${debugLabel}]`, {
        method: normalizedMethod,
        status: response.status,
        ok: response.ok,
      });
    }
    return (payload && Object.prototype.hasOwnProperty.call(payload, 'data')
      ? payload.data
      : payload) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const timeoutError = new Error(`Backend IPAW timeout setelah ${timeoutMs}ms.`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function getIpawBackendUrl(): string {
  const runtime = typeof globalThis !== 'undefined'
    ? globalThis.__IPAW_BACKEND_URL__
    : undefined;
  const configured = runtime || (import.meta.env.VITE_IPAW_BACKEND_URL as string | undefined) || IPAW_BACKEND_URL;
  return configured.trim().replace(/\/$/, '');
}

/**
 * Check the dedicated Netlify backend without exposing any TrakCare details
 * to the browser. This is intentionally separate from the Replit API health
 * check because the GAS-hosted bundle only knows the Netlify URL.
 */
export async function checkBackendConnection(timeoutMs = 8_000): Promise<boolean> {
  try {
    await ipawApi<{ service?: string; status?: string }>('/api/health', {
      method: 'GET',
      timeoutMs,
      debugLabel: 'health',
    });
    return true;
  } catch {
    return false;
  }
}

function sanitizeForLog(value: unknown, key = ''): unknown {
  if (/(password|token|secret|apikey|authorization|credential|hash)/i.test(key)) {
    return '[REDACTED]';
  }
  // TrakCare responses and Cloud snapshots can contain patient records.
  // Keep the response shape visible in debug mode without logging PHI.
  if (/(body|html|database|records|patients)/i.test(key)) {
    return '[OMITTED SENSITIVE PAYLOAD]';
  }
  if (Array.isArray(value)) return value.map(item => sanitizeForLog(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeForLog(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function safeGasUrl(baseUrl: string): URL {
  const normalized = baseUrl.trim();
  if (!normalized || !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/i.test(normalized)) {
    throw new Error('URL GAS tidak valid. Gunakan URL Web App deployment yang berakhiran /exec.');
  }
  return new URL(normalized);
}

/**
 * Centralized GET/POST client for direct Google Apps Script requests.
 *
 * The helper intentionally returns both the native Response and parsed JSON
 * so callers can preserve their existing success handling without duplicating
 * timeout, parsing, and diagnostics logic.
 */
export async function apiRequest<T = any>(
  endpoint: string,
  options: ApiRequestOptions = {},
  baseUrl = GAS_API_URL,
): Promise<ApiRequestResult<T>> {
  const { timeoutMs = GAS_REQUEST_TIMEOUT_MS, debugLabel = endpoint, ...requestInit } = options;
  const target = new URL(endpoint, safeGasUrl(baseUrl)).toString();
  const method = (requestInit.method ?? 'GET').toUpperCase();
  const headers = new Headers(requestInit.headers);
  if (method !== 'GET' && requestInit.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', headers.get('Accept') || 'application/json');

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  if (API_DEBUG) {
    const debugUrl = new URL(target);
    for (const key of ['apiKey', 'token', 'access_token']) {
      if (debugUrl.searchParams.has(key)) debugUrl.searchParams.set(key, '[REDACTED]');
    }
    console.log(`[GAS API][${debugLabel}] request`, {
      url: debugUrl.toString(),
      method,
    });
  }

  try {
    const response = await fetch(target, {
      ...requestInit,
      headers,
      signal: controller.signal,
    });
    const raw = await response.text();
    let data: T;
    try {
      data = (raw ? JSON.parse(raw) : null) as T;
    } catch (error) {
      const parseError = new Error(
        `Respons GAS bukan JSON yang valid (HTTP ${response.status}).`,
      );
      console.error(`[GAS API][${debugLabel}] response parse error`, error);
      throw parseError;
    }

    if (API_DEBUG) {
      console.log(`[GAS API][${debugLabel}] response`, {
        status: response.status,
        ok: response.ok,
        json: sanitizeForLog(data),
      });
    }
    if (!response.ok) {
      throw new Error(
        (data as any)?.error || `GAS merespons HTTP ${response.status}.`,
      );
    }
    if ((data as any)?.success === false) {
      throw new Error((data as any)?.error || 'GAS menolak permintaan.');
    }
    return { response, data };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const timeoutError = new Error(`Request ke GAS timeout setelah ${timeoutMs}ms.`);
      timeoutError.name = 'TimeoutError';
      console.error(`[GAS API][${debugLabel}] fetch error`, timeoutError);
      throw timeoutError;
    }
    console.error(`[GAS API][${debugLabel}] fetch error`, error);
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function getStandaloneQueryOverride(name: 'apiProxy' | 'otProxy'): string {
  if (typeof window === 'undefined' || window.location.protocol !== 'file:') return '';
  try {
    return new URLSearchParams(window.location.search).get(name)?.trim().replace(/\/$/, '') || '';
  } catch {
    return '';
  }
}

export function getApiBaseUrl(): string {
  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'file:' &&
    typeof globalThis.__IPAW_OFFLINE_API_BASE__ === 'string'
  ) {
    return (
      getStandaloneQueryOverride('apiProxy') ||
      globalThis.__IPAW_OFFLINE_API_BASE__.trim().replace(/\/$/, '')
    );
  }

  const envUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  return envUrl.trim().replace(/\/$/, ''); // hapus trailing slash
}

/**
 * Standalone launcher compatibility.
 *
 * The Windows launcher starts a local bridge before opening ipaw.html. When
 * the file is opened manually, the bridge may still be running from an
 * earlier session but there is no query-string override. Probe its health
 * endpoint so Cloud and TrakCare use the workstation route automatically.
 * A failed probe is intentionally silent: direct GAS/TrakCare remains the
 * fallback for browsers that do not use the launcher.
 */
export async function activateOfflineBridge(): Promise<string> {
  if (typeof window === 'undefined' || window.location.protocol !== 'file:') return '';

  const explicit = getStandaloneQueryOverride('apiProxy');
  if (explicit) {
    globalThis.__IPAW_OFFLINE_API_BASE__ = explicit;
    return explicit;
  }

  const current = globalThis.__IPAW_OFFLINE_API_BASE__?.trim().replace(/\/$/, '') || '';
  if (current) return current;

  const bridgeBase = 'http://127.0.0.1:8765';
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`${bridgeBase}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.ok) {
      globalThis.__IPAW_OFFLINE_API_BASE__ = bridgeBase;
      return bridgeBase;
    }
  } catch {
    // Direct GAS remains the fallback when the local bridge is unavailable.
  } finally {
    window.clearTimeout(timeoutId);
  }
  return '';
}

/**
 * Bangun URL API absolut dari path relatif, misal:
 *   apiUrl('/api/cloud/status') → '' + '/api/cloud/status'  (local)
 *                              → 'https://api.example.com/api/cloud/status' (prod)
 */
export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${cleanPath}`;
}

export function getOfflineOperatingTheatreProxyBase(): string {
  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'file:' &&
    typeof globalThis.__IPAW_OFFLINE_OT_PROXY_BASE__ === 'string'
  ) {
    return (
      getStandaloneQueryOverride('otProxy') ||
      getStandaloneQueryOverride('apiProxy') ||
      globalThis.__IPAW_OFFLINE_OT_PROXY_BASE__.trim().replace(/\/$/, '')
    );
  }
  return '';
}

/**
 * Deteksi apakah API proxy tersedia (Express server atau Netlify Functions).
 *
 * Proxy tersedia jika:
 *  - VITE_API_BASE_URL dikonfigurasi (API server eksternal), ATAU
 *  - VITE_HAS_API_PROXY=true di-set saat build (misal via Netlify Functions), ATAU
 *  - Build dilakukan di dalam Replit (__IS_REPLIT__ = true)
 *
 * Mode Netlify static (tanpa VITE_API_BASE_URL) → false → panggil GAS langsung.
 * Mode file:// (offline standalone HTML) → false.
 *
 * Catatan: Dulu menggunakan window.location.protocol === 'https:' sebagai fallback,
 * tetapi ini SALAH untuk Netlify (https:// tapi tidak ada /api/ di sana).
 * Sekarang menggunakan build-time constant __IS_REPLIT__ yang di-inject vite.
 */
export function hasApiProxy(): boolean {
  // GAS-hosted V3 uses the same deployment as the Cloud endpoint. It must not
  // inherit the Replit build flag and try to call a non-existent /api route.
  if (isGasHosted()) {
    return false;
  }

  // Explicit external API server (misal Railway/Render)
  if (getApiBaseUrl() !== '') return true;

  // Explicit flag dari Netlify Functions atau konfigurasi build lain
  if ((import.meta.env.VITE_HAS_API_PROXY as string | undefined) === 'true') return true;

  if (typeof window === 'undefined') return false;

  // Standalone ipaw.html can inject a public API proxy so Cloud Backup still
  // works from file://. A normal file without that override remains direct.
  if (window.location.protocol === 'file:') {
    return getApiBaseUrl() !== '';
  }

  // Replit dev atau Replit production — shared Express proxy tersedia di /api/
  try {
    return Boolean(__IS_REPLIT__);
  } catch {
    return false;
  }
}

/**
 * Deteksi apakah proxy TrakCare tersedia — yaitu server yang BISA menjangkau
 * jaringan internal RS (apps.emc.id, appsprn.emc.id).
 *
 * PENTING: Berbeda dari hasApiProxy()!
 * Netlify Functions berjalan di server internet → TIDAK BISA menjangkau
 * jaringan internal RS. Maka VITE_HAS_API_PROXY=true (untuk fitur AI/Cloud)
 * TIDAK boleh mengaktifkan proxy TrakCare.
 *
 * Proxy TrakCare hanya aktif jika:
 *  - VITE_API_BASE_URL dikonfigurasi (server internal/eksternal yg bisa akses RS), ATAU
 *  - VITE_TRAKCARE_HAS_PROXY=true (set secara eksplisit untuk internal server), ATAU
 *  - Replit (__IS_REPLIT__ = true) — Express berjalan di server yg sama.
 *
 * Jika false → browser melakukan direct fetch ke TrakCare.
 * Ini bekerja jika pengguna terhubung ke jaringan internal RS EMC.
 */
export function hasTrakCareProxy(): boolean {
  // The standalone bundle injects the localhost PowerShell bridge. The bridge
  // runs on the hospital workstation, so it can reach both Cloud and the
  // internal TrakCare hosts without relying on a cloud proxy.
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    return getApiBaseUrl() !== '';
  }

  // HANYA aktif jika ada server eksternal/internal yang BISA menjangkau jaringan RS.
  //
  // ⚠️  __IS_REPLIT__ TIDAK digunakan di sini — Express server Replit berjalan di
  //     cloud internet dan tidak bisa resolve domain internal RS (apps.emc.id,
  //     appsprn.emc.id). Browser pengguna yang di jaringan RS lebih andal.
  //
  // Cara mengaktifkan proxy TrakCare:
  //   Opsi 1 — Server eksternal/internal:
  //     set VITE_API_BASE_URL=https://api-internal.rs-emc.id di Netlify/build env
  //   Opsi 2 — Flag eksplisit:
  //     set VITE_TRAKCARE_HAS_PROXY=true (hanya jika ada server yg bisa akses RS)

  // Explicit external server dikonfigurasi → pakai proxy
  if (getApiBaseUrl() !== '') return true;

  // Flag eksplisit untuk server internal yang bisa menjangkau TrakCare
  if ((import.meta.env.VITE_TRAKCARE_HAS_PROXY as string | undefined) === 'true') return true;

  // Semua kondisi lain (Replit dev, Netlify, local dev) → direct browser fetch
  return false;
}

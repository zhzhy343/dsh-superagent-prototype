/** HTTP access to git.weixin.qq.com's GitLab-v3-compatible API, authenticated by the account's private key file. */
import { readFile } from 'node:fs/promises'
import type { z } from 'zod'

/** Source id and the fixed service this Source reads; the token never leaves the machine except as an API header. */
export const SOURCE = 'weixin'
export const BASE_URL = 'https://git.weixin.qq.com'
export const API_URL = `${BASE_URL}/api/v3`
const TIMEOUT_MS = 30_000

/** A failed API request; `status` is the HTTP status when the service answered. */
export class WeixinApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'WeixinApiError'
  }
}

export interface WeixinApiConfig { repository: string; tokenFile: string }

/** Reads the account's private key from `tokenFile`; its contents are never logged or stored in settings. */
export async function privateKey(config: WeixinApiConfig): Promise<string> {
  if (!config.tokenFile) throw new WeixinApiError('The Weixin Source names no private-key file')
  try {
    const value = (await readFile(config.tokenFile, 'utf8')).trim()
    if (!value) throw new WeixinApiError(`The private-key file ${config.tokenFile} is empty`)
    return value
  } catch (error) {
    if (error instanceof WeixinApiError) throw error
    throw new WeixinApiError(`Cannot read the private-key file ${config.tokenFile}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The API's own error message, without an HTML page or an unbounded body. */
function messageOf(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown }
    const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : undefined
    if (message) return message.slice(0, 300)
  } catch { /* A non-JSON error body is shortened below. */ }
  const plain = text.trim()
  return plain ? plain.slice(0, 300) : undefined
}

/**
 * Calls the API on `path` (relative to `/api/v3`) with the configured private key and parses its JSON with `schema`.
 * @throws WeixinApiError when the private key is unreadable, the request fails, the service rejects it, or the body is not JSON.
 */
export async function api<T>(config: WeixinApiConfig, path: string, schema: z.ZodType<T>, init: RequestInit = {},
  signal?: AbortSignal): Promise<T> {
  const key = await privateKey(config)
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(`${API_URL}/${path}`, { ...init, signal: combined,
      headers: { Accept: 'application/json', 'PRIVATE-TOKEN': key, ...init.headers } })
  } catch (error) {
    // A caller's stop is not a poll failure; the Source loop checks its signal before reporting one.
    if (signal?.aborted) throw error
    throw new WeixinApiError(timeout.aborted ? `The Weixin API did not answer within ${TIMEOUT_MS / 1000} s`
      : `The Weixin API could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  if (!response.ok) throw new WeixinApiError(messageOf(text) ?? `The Weixin API answered HTTP ${response.status}`, response.status)
  try { return schema.parse(JSON.parse(text) as unknown) }
  catch (error) {
    if (error instanceof SyntaxError) throw new WeixinApiError('The Weixin API returned invalid JSON')
    throw error
  }
}

/** Posts a JSON body to `path`, as notes and other writes do. */
export function post<T>(config: WeixinApiConfig, path: string, schema: z.ZodType<T>, body: Record<string, unknown>,
  signal?: AbortSignal): Promise<T> {
  return api(config, path, schema, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal)
}

/** The project segment of every project-scoped path, with the `/` between a namespace and its project encoded as the API documents. */
export const projectPath = (repository: string): string => `projects/${encodeURIComponent(repository)}`

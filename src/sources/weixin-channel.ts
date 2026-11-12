/** Weixin code repository outbound channel: posts issue and merge request notes once per outgoing message. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { api, post, projectPath, WeixinApiError } from './weixin-api.ts'
import { targetPage, type TargetKind } from './weixin-trigger.ts'
import type { ChannelLink } from './kind.ts'
import type { WeixinConfig } from './weixin.ts'

const NoteBody = z.looseObject({ id: z.number(), body: z.string().nullish() })
const Notes = z.array(NoteBody)
/** Bounds the idempotency scan on a very long conversation; a marker beyond this many notes can be posted again. */
const MAX_SCAN_PAGES = 20
const MARKER = (id: string): string => `<!-- dsh-superagent:${id} -->`

/** True when a project is still readable, so a 404 on its issue or merge request means that object is gone rather than access lost. */
async function projectReadable(config: WeixinConfig, repository: string): Promise<boolean> {
  try {
    await api(config, projectPath(repository), z.unknown())
    return true
  } catch (error) {
    if (error instanceof WeixinApiError && error.status === 404) return false
    throw error
  }
}

/**
 * Posts `message` as a note under the issue or merge request its Channel address names.
 * The note carries an HTML marker and existing notes are checked first, so a retried delivery does not duplicate it.
 * Returns `'gone'` when the project is readable but the target no longer is; a 404 while the project is unreadable is
 * retried, because it can mean lost access that an operator may restore.
 */
export async function sendWeixin(message: OutboundMessage, config: WeixinConfig): Promise<'sent' | 'gone'> {
  const target = message.channel.address.target
  const recordId = Number(message.channel.address.recordId)
  const repository = message.channel.address.repository || config.repository
  if ((target !== 'issue' && target !== 'merge_request') || !recordId || !repository) throw new Error('Missing Weixin reply target')
  const path = `${projectPath(repository)}/${target === 'issue' ? 'issues' : 'merge_requests'}/${recordId}/notes`
  const marker = MARKER(message.id)
  try {
    for (let page = 1; page <= MAX_SCAN_PAGES; page++) {
      const notes = await api(config, `${path}?per_page=100&page=${page}`, Notes)
      if (notes.some(note => (note.body ?? '').includes(marker))) return 'sent'
      if (notes.length < 100) break
    }
    await post(config, path, z.unknown(), { body: `${message.text}\n\n${marker}` })
    return 'sent'
  } catch (error) {
    if (error instanceof WeixinApiError && error.status === 410) return 'gone'
    if (error instanceof WeixinApiError && error.status === 404 && await projectReadable(config, repository)) return 'gone'
    throw error
  }
}

/** The page of the issue or merge request a reply goes to, or the Trigger's own page when it carried one. */
export function weixinLink(address: Record<string, string>): ChannelLink {
  const target: TargetKind = address.target === 'merge_request' ? 'merge_request' : 'issue'
  const iid = Number(address.iid)
  const url = address.url || (address.repository && iid ? targetPage(address.repository, target, iid) : '')
  const number = `${target === 'issue' ? '#' : '!'}${address.iid ?? ''}`
  return { url, label: { zh: `微信代码仓库 ${number}`, en: `WeChat code repository ${number}` } }
}

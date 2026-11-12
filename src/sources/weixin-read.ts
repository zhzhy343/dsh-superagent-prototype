/** Trigger-scoped reads of a Weixin issue or merge request conversation, for assessments. */
import { z } from 'zod'
import { isoTime, type Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { api, projectPath } from './weixin-api.ts'
import { NoteSchema, notePage, TargetSchema, targetPage, targetRoot, type TargetKind } from './weixin-trigger.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import type { WeixinConfig } from './weixin.ts'

const Notes = z.array(NoteSchema)
const PAGE_SIZE = 100
const MAX_PAGE = 10_000

function targetOf(trigger: Trigger): { target: TargetKind; iid: number; recordId: number; repository: string } {
  const target = trigger.meta.target === 'merge_request' ? 'merge_request' : 'issue'
  const iid = Number(trigger.meta.number)
  const recordId = Number(trigger.meta.recordId)
  const repository = typeof trigger.meta.repository === 'string' ? trigger.meta.repository : ''
  if (!iid || !recordId || !repository) throw new Error('The Weixin trigger names no issue or merge request')
  return { target, iid, recordId, repository }
}

function rootMessage(target: TargetKind, iid: number, item: z.infer<typeof TargetSchema>, repository: string): ContextMessage {
  const url = targetPage(repository, target, iid, item.web_url)
  return { id: targetRoot(target, iid), from: item.author.username, at: isoTime(item.created_at),
    text: `${item.title}\n\n${item.description ?? ''}`, url }
}

/** A page of the conversation: the issue or merge request body first, then its notes; later pages hold only notes. */
export const weixinThreadContext: ThreadContext<WeixinConfig> = {
  messageId: trigger => {
    if (trigger.meta.kind === 'note' && typeof trigger.meta.noteId === 'number') return String(trigger.meta.noteId)
    const { target, iid } = targetOf(trigger)
    return targetRoot(target, iid)
  },
  async read(_commands: Commands, trigger: Trigger, part, cursor, config): Promise<ContextPart> {
    const { target, iid, recordId, repository } = targetOf(trigger)
    // API paths take the globally unique id; the web page and the Thread use the project's own iid.
    const segmentPath = `${projectPath(repository)}/${target === 'issue' ? 'issues' : 'merge_requests'}`
    const detailPath = `${segmentPath}/${recordId}`
    if (part === 'root' || part === 'parent') {
      const item = await api(config, detailPath, TargetSchema)
      const messages = [rootMessage(target, iid, item, repository)]
      return { messages, body: { status: 'weixin_root', target, number: iid, messages } }
    }
    const page = cursor === undefined ? 1 : Number(cursor)
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) throw new Error('The Weixin context page is invalid')
    const [item, notes] = await Promise.all([
      api(config, detailPath, TargetSchema),
      api(config, `${detailPath}/notes?per_page=${PAGE_SIZE}&page=${page}`, Notes),
    ])
    const shown = notes.filter(note => !note.system && !!note.body)
    const messages = shown.map(note => ({ id: String(note.id), from: note.author.username, at: isoTime(note.created_at),
      text: note.body!, url: notePage(targetPage(repository, target, iid, item.web_url), note.id) }))
    const first = page === 1 ? [rootMessage(target, iid, item, repository)] : []
    const result = [...first, ...messages]
    const next = notes.length === PAGE_SIZE ? String(page + 1) : undefined
    return { messages: result, next, body: { status: 'weixin_thread', target, number: iid, page, messages: result } }
  },
}

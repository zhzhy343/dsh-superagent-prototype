/** Normalizes git.weixin.qq.com issues, merge requests and notes into domain Triggers. */
import { z } from 'zod'
import { isoTime, key, threadKey, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import { BASE_URL, SOURCE } from './weixin-api.ts'

/** The two project objects a person can write in; notes belong to one of them. */
export type TargetKind = 'issue' | 'merge_request'
/** The project's own number of an issue or merge request, as the API calls `iid`. */
export const targetThread = (target: TargetKind, iid: number): string => `${target}:${iid}`
export const targetThreadKey = (target: TargetKind, iid: number): string =>
  threadKey({ source: SOURCE, id: targetThread(target, iid) })
export const targetRoot = (target: TargetKind, iid: number): string => targetThread(target, iid)
const segment = (target: TargetKind): string => target === 'issue' ? 'issues' : 'merge_requests'
/** The web page of an issue or merge request; the API's own `web_url` is preferred when it came with the event. */
export const targetPage = (repository: string, target: TargetKind, iid: number, webUrl?: string | null): string =>
  webUrl || `${BASE_URL}/${repository}/${segment(target)}/${iid}`
export const notePage = (url: string, noteId: number): string => `${url}#note_${noteId}`
/**
 * The Channel address of an issue or merge request conversation.
 * `iid` is the project's own number for pages and Threads; `recordId` is the API's globally unique id, which its endpoints take.
 */
export const targetChannel = (target: TargetKind, iid: number, recordId: number, repository: string,
  url?: string | null): ChannelRef =>
  ({ source: SOURCE, thread: targetThreadKey(target, iid),
    address: { target, iid: String(iid), recordId: String(recordId), repository, ...url ? { url } : {} } })

/** A person as the API reports it; a deleted account is shown as `ghost`. */
export const UserSchema = z.looseObject({ id: z.number().nullish(), username: z.string(), name: z.string().nullish() })
  .nullish().transform(user => user ?? { username: 'ghost' })
export type WeixinUser = z.infer<typeof UserSchema>
/** An issue or merge request as the list endpoints return it; both share the fields a Thread needs. */
export const TargetSchema = z.looseObject({
  id: z.number(), iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  created_at: z.string(), updated_at: z.string(), web_url: z.string().nullish(), author: UserSchema,
})
export type WeixinTarget = z.infer<typeof TargetSchema>
/** A note (comment) of an issue or merge request; `system` notes record state changes rather than a person's words. */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema, created_at: z.string(), system: z.boolean().nullish(),
  noteable_type: z.string().nullish(), noteable_id: z.number().nullish(),
})
export type WeixinNote = z.infer<typeof NoteSchema>

/** True when `text` mentions `account` as a whole GitLab username, which may contain `.`, `-` and `_`; a trailing `.` is punctuation. */
export const mentions = (text: string, account: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(account)}(?![a-zA-Z0-9_-]|\\.[a-zA-Z0-9_-])`, 'i').test(text)
/** GitLab bot accounts end in `_bot` or `-bot`; a mirrored GitHub-style name may end in `[bot]`. */
export const isWeixinBot = (username: string): boolean => /(?:\[bot\]|_bot|-bot)$/i.test(username)
const author = (user: WeixinUser, account: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: !isWeixinBot(user.username) && !sameName(user.username, account) })
const bodyText = (target: Pick<WeixinTarget, 'title' | 'description'>): string => `${target.title}\n\n${target.description ?? ''}`

/** Builds the Trigger for a newly opened issue; its body is untrusted external text. */
export function issueTrigger(issue: WeixinTarget, repository: string, account: string): Trigger {
  const text = bodyText(issue)
  return { id: key('weixin-issue', repository, String(issue.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: targetThread('issue', issue.iid) }], ...author(issue.author, account), at: isoTime(issue.created_at),
    text, ...(mentions(text, account) ? { addressed: 'mention' as const } : {}),
    channel: targetChannel('issue', issue.iid, issue.id, repository, issue.web_url),
    url: targetPage(repository, 'issue', issue.iid, issue.web_url),
    meta: { kind: 'issue', target: 'issue', number: issue.iid, recordId: issue.id, repository, account } }
}

/** Builds the Trigger for a newly opened merge request. */
export function mergeTrigger(pull: WeixinTarget, repository: string, account: string): Trigger {
  const text = bodyText(pull)
  return { id: key('weixin-merge-request', repository, String(pull.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: targetThread('merge_request', pull.iid) }], ...author(pull.author, account), at: isoTime(pull.created_at),
    text, ...(mentions(text, account) ? { addressed: 'mention' as const } : {}),
    channel: targetChannel('merge_request', pull.iid, pull.id, repository, pull.web_url),
    url: targetPage(repository, 'merge_request', pull.iid, pull.web_url),
    meta: { kind: 'merge_request', target: 'merge_request', number: pull.iid, recordId: pull.id, repository, account } }
}

/**
 * Builds the Trigger for a note on an issue or merge request.
 * Returns undefined for a system note, an empty note, or the agent's own note, which never enters the domain.
 */
export function noteTrigger(note: WeixinNote, target: TargetKind, iid: number, recordId: number, repository: string,
  webUrl: string | null | undefined, account: string): Trigger | undefined {
  if (note.system || !note.body || sameName(note.author.username, account)) return undefined
  const at = isoTime(note.created_at)
  const url = notePage(targetPage(repository, target, iid, webUrl), note.id)
  return { id: key('weixin-note', repository, String(note.id)), source: SOURCE,
    threads: [{ source: SOURCE, id: targetThread(target, iid) }], ...author(note.author, account), at, text: note.body,
    ...(mentions(note.body, account) ? { addressed: 'mention' as const } : {}),
    channel: targetChannel(target, iid, recordId, repository, webUrl), url,
    meta: { kind: 'note', target, number: iid, recordId, noteId: note.id, repository, account } }
}

/** Maps a search query to the Threads it names: `#12` an issue, `!12` a merge request, and a bare number or URL both. */
export function findWeixin(query: string): { threads: string[]; terms: string[] } {
  const trimmed = query.trim()
  const page = /git\.weixin\.qq\.com\/.+\/(issues|merge_requests)\/(\d+)/.exec(trimmed)
  if (page) return { threads: [`${SOURCE}:${targetThread(page[1] === 'issues' ? 'issue' : 'merge_request', Number(page[2]))}`], terms: [] }
  const issue = /^#(\d+)$/.exec(trimmed)
  if (issue) return { threads: [`${SOURCE}:${targetThread('issue', Number(issue[1]))}`], terms: [] }
  const merge = /^!(\d+)$/.exec(trimmed)
  if (merge) return { threads: [`${SOURCE}:${targetThread('merge_request', Number(merge[1]))}`], terms: [] }
  const number = /^(\d+)$/.exec(trimmed)
  return { threads: number ? [`${SOURCE}:${targetThread('issue', Number(number[1]))}`,
    `${SOURCE}:${targetThread('merge_request', Number(number[1]))}`] : [], terms: [] }
}

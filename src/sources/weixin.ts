/** WeChat code repository Source: a project's issues, merge requests and comments on git.weixin.qq.com, and its Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { ScopeResult } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { EnvironmentInput, Localized, SourceKind } from './kind.ts'
import { cursorAt, pause } from './poll.ts'
import { api, projectPath, SOURCE, WeixinApiError } from './weixin-api.ts'
import { sendWeixin, weixinLink } from './weixin-channel.ts'
import { weixinThreadContext } from './weixin-read.ts'
import { findWeixin, issueTrigger, mergeTrigger, noteTrigger, NoteSchema, targetPage, targetThread, targetThreadKey,
  TargetSchema, type TargetKind } from './weixin-trigger.ts'

const RepositorySchema = z.string().trim().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/, 'namespace/project')
/** Source settings; the private key itself stays in a file, never in settings or a prompt. */
export const WeixinConfigSchema = z.object({
  repository: z.union([z.literal(''), RepositorySchema]).default(''),
  tokenFile: z.string().trim().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observePulls: z.boolean().default(false),
  observeComments: z.boolean().default(false),
}).strict()
export type WeixinConfig = z.infer<typeof WeixinConfigSchema>
const MeSchema = z.looseObject({ username: z.string() })
const Targets = z.array(TargetSchema)
const Notes = z.array(NoteSchema)
const PAGE_SIZE = 100
const MAX_PAGES = 20
const STREAMS = [
  { id: 'issues', target: 'issue', path: 'issues', observed: (config: WeixinConfig) => config.observeIssues },
  { id: 'merge_requests', target: 'merge_request', path: 'merge_requests', observed: (config: WeixinConfig) => config.observePulls },
] as const satisfies readonly { id: string; target: TargetKind; path: string; observed: (config: WeixinConfig) => boolean }[]

/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
const listPath = (repository: string, path: string, page: number): string =>
  // Closed issues and merge requests can still receive a new comment, so the list is not limited to open ones; no `state`
  // parameter returns every state, which also avoids the merge request list's stricter state values.
  `${projectPath(repository)}/${path}?order_by=updated_at&sort=desc&per_page=${PAGE_SIZE}&page=${page}`
const notePath = (repository: string, target: TargetKind, recordId: number, page: number): string =>
  `${projectPath(repository)}/${target === 'issue' ? 'issues' : 'merge_requests'}/${recordId}/notes?per_page=${PAGE_SIZE}&page=${page}`

/** True when the configuration names the two values every request needs. */
export const configured = (config: WeixinConfig): boolean => !!config.repository && !!config.tokenFile

/** Polls one stream's open issues or merge requests from its saved cursor, emitting new bodies and new notes. */
async function pollStream(ctx: SourceContext, config: WeixinConfig, started: string,
  stream: (typeof STREAMS)[number], account: string, signal: AbortSignal): Promise<void> {
  const sinceKey = KV.weixin.since(stream.id)
  const since = ctx.state.get(sinceKey)
  // The first poll after the stream is switched on establishes the baseline; older items are not replayed.
  if (!since) { ctx.state.set(sinceKey, cursorAt(started)); return }
  const sinceTime = Date.parse(since)
  if (!Number.isFinite(sinceTime)) { ctx.state.set(sinceKey, cursorAt(started)); return }
  const repository = config.repository
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await api(config, listPath(repository, stream.path, page), Targets, {}, signal)
    let oldest = Number.POSITIVE_INFINITY
    for (const item of items) {
      oldest = Math.min(oldest, Date.parse(item.updated_at))
      const thread = targetThread(stream.target, item.iid)
      const url = targetPage(repository, stream.target, item.iid, item.web_url)
      ctx.threads.describe(targetThreadKey(stream.target, item.iid), {
        label: `${stream.target === 'issue' ? '#' : '!'}${item.iid} ${item.title}`, url,
        facts: { number: { value: `${stream.target === 'issue' ? '#' : '!'}${item.iid}` }, state: { value: item.state } },
      })
      // The agent's own writes are not events, but its thread description above still lands.
      if (!sameName(item.author.username, account) && Date.parse(item.created_at) >= sinceTime) {
        await ctx.receive(stream.target === 'issue' ? issueTrigger(item, repository, account) : mergeTrigger(item, repository, account))
      }
      if (Date.parse(item.updated_at) < sinceTime) continue
      await pollNotes(ctx, config, thread, stream.target, item.iid, item.id, item.web_url, account, sinceTime, signal)
    }
    if (items.length < PAGE_SIZE || oldest < sinceTime) break
  }
  ctx.state.set(sinceKey, cursorAt(started))
}

/** Reads the notes of one updated issue or merge request, emitting the new ones and advancing that Thread's note cursor. */
async function pollNotes(ctx: SourceContext, config: WeixinConfig, thread: string, target: TargetKind, iid: number,
  recordId: number, webUrl: string | null | undefined, account: string, sinceTime: number, signal: AbortSignal): Promise<void> {
  const cursorKey = KV.weixin.note(thread)
  const known = ctx.state.get(cursorKey)
  let newest = known ?? 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    const notes = await api(config, notePath(config.repository, target, recordId, page), Notes, {}, signal)
    for (const note of notes) {
      newest = Math.max(newest, note.id)
      // A Thread seen for the first time only replays notes written since the stream cursor; later polls use the note id.
      const fresh = known === undefined ? Date.parse(note.created_at) >= sinceTime : note.id > known
      if (!fresh) continue
      const trigger = noteTrigger(note, target, iid, recordId, config.repository, webUrl, account)
      if (trigger) await ctx.receive(trigger)
    }
    if (notes.length < PAGE_SIZE) break
  }
  ctx.state.set(cursorKey, newest)
}

/**
 * One poll round: reads the account identity and every observed stream.
 * The account's own notes and issues are dropped; the second person's first run after switching a stream on only sets its baseline.
 */
export async function pollRound(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const config = ctx.config<WeixinConfig>(SOURCE)
  if (!config || !configured(config)) return
  const started = new Date().toISOString()
  const me = await api(config, 'user', MeSchema, {}, signal)
  for (const stream of STREAMS) {
    if (!stream.observed(config)) { ctx.state.set(KV.weixin.since(stream.id), undefined); continue }
    await pollStream(ctx, config, started, stream, me.username, signal)
  }
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  let interval = 60
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<WeixinConfig>(SOURCE)
    if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else if (!configured(config)) ctx.report(SOURCE, { state: 'paused', detail: 'Set the project and the private-key file' })
    else {
      try {
        await pollRound(ctx, signal)
        failures = 0
        interval = config.pollSeconds
        ctx.report(SOURCE, { state: 'ready', detail: '' })
      } catch (error) {
        if (signal.aborted) return
        failures += 1
        if (error instanceof WeixinApiError && (error.status === 401 || error.status === 403)) {
          ctx.report(SOURCE, { state: 'error', detail: `The private key was rejected: ${error.message}` })
        } else if (error instanceof WeixinApiError && /private-key file/.test(error.message)) {
          ctx.report(SOURCE, { state: 'error', detail: error.message })
        } else {
          const failed = pollFailure(failures, config.failuresBeforeError, error)
          if (failed) ctx.report(SOURCE, failed)
        }
      }
    }
    await pause(Math.max(interval, ctx.config<WeixinConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
const row = (id: string, label: Localized, observed: boolean | undefined) => ({ id, label, note: note(observed),
  cells: { listedUnaddressed: !!observed, unlistedAddressed: true, unlistedUnaddressed: !!observed } })
const str = (value: unknown): string => typeof value === 'string' ? value : ''

/**
 * The Weixin Source kind, built with a getter for its current settings so its Channel sends with the settings in force.
 * `current` returns undefined while the Source is off.
 */
export function weixinKind(current: () => WeixinConfig | undefined): SourceKind<WeixinConfig> {
  return {
    kind: SOURCE,
    title: { zh: '微信代码仓库', en: 'WeChat code repository' },
    description: { zh: '接收 git.weixin.qq.com 上一个项目里的缺陷、合并请求和评论。',
      en: 'Receives issues, merge requests and comments of one project on git.weixin.qq.com.' },
    schema: WeixinConfigSchema,
    fields: [
      { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-/]+', label: { zh: '监听的项目', en: 'Project' },
        hint: { zh: '写作 namespace/project，例如 u/zhangsan/demo。只读取这个项目的缺陷和合并请求。', en: 'Written namespace/project, such as u/zhangsan/demo. Only this project\'s issues and merge requests are read.' } },
      { key: 'tokenFile', type: 'text', label: { zh: '私钥文件', en: 'Private-key file' },
        hint: { zh: '保存账号 Private Key 的文件的绝对路径，在 git.weixin.qq.com 的个人设置里生成。文件内容不会存进设置或提示词。', en: 'Absolute path of a file holding the account\'s Private Key from git.weixin.qq.com profile settings. Its contents are never stored in settings or prompts.' } },
      { key: 'observeIssues', type: 'switch', label: { zh: '接收新缺陷', en: 'Receive new issues' } },
      { key: 'observePulls', type: 'switch', label: { zh: '接收新合并请求', en: 'Receive new merge requests' } },
      { key: 'observeComments', type: 'switch', label: { zh: '接收全部评论', en: 'Receive all comments' } },
      { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
      { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告', en: 'Failures before reporting' } },
    ],
    health: [SOURCE],
    scope: ({ meta }, config): ScopeResult => {
      if (meta.kind === 'issue') return { listened: true, observed: config.observeIssues, row: 'issues' }
      if (meta.kind === 'merge_request') return { listened: true, observed: config.observePulls, row: 'pulls' }
      if (meta.kind === 'note') return { listened: true, observed: config.observeComments, row: 'comments' }
      return { listened: false, reason: 'unsupported_kind' }
    },
    channel: {
      allowed: (address, config) => !!config.repository && (address.target === 'issue' || address.target === 'merge_request'),
      send: (_host, message) => {
        const config = current()
        if (!config) throw new Error('The Weixin Source is off')
        return sendWeixin(message, config)
      },
      link: weixinLink,
    },
    threadContext: weixinThreadContext,
    find: findWeixin,
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
        bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
      fields: [
        { key: 'allowed', type: 'rows', label: { zh: '能发起工作的微信代码仓库账号', en: 'WeChat code repository accounts that may originate work' },
          columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
        { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
          hint: { zh: '名单里账号的评论成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他账号的评论不接收。', en: 'A comment of an account on this list becomes an inferred candidate for an assessment; it never makes an explicit request or stops a ticket. Other accounts\' comments are not admitted.' },
          columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
      ],
      explicit: { zh: '名单里的账号在缺陷、合并请求或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an issue, merge request or comment.' },
      rows(stored) {
        const config = WeixinConfigSchema.partial().parse(stored)
        return [row('issues', { zh: '新缺陷', en: 'New issues' }, config.observeIssues),
          row('pulls', { zh: '新合并请求', en: 'New merge requests' }, config.observePulls),
          row('comments', { zh: '评论', en: 'Comments' }, config.observeComments)]
      },
    },
    environment: {
      variables: [
        { key: 'DSH_SUPERAGENT_WEIXIN_REPOSITORY', description: { zh: '这个来源监听的项目，namespace/project。检出和推送由 Execution 的 prepare 命令负责。', en: 'The project this Source watches, as namespace/project. Checkout and push are done by the prepare command in Execution settings.' } },
        { key: 'DSH_SUPERAGENT_WEIXIN_ACCOUNT', description: { zh: '智能体在微信代码仓库的账号名，用来在评论里 @ 它。', en: 'The agent\'s account name on the WeChat code repository, used to mention it in comments.' } },
        { key: 'DSH_SUPERAGENT_WEIXIN_KIND', description: { zh: '工单来自缺陷（issue）还是合并请求（merge_request）。', en: 'Whether the ticket came from an issue or a merge request.' } },
        { key: 'DSH_SUPERAGENT_WEIXIN_NUMBER', description: { zh: '接下工单的缺陷或合并请求编号；工单不是从这个来源来的时为空。', en: 'Number of the issue or merge request that started the ticket; empty when it did not start here.' } },
        { key: 'DSH_SUPERAGENT_WEIXIN_WEB_URL', description: { zh: '这个缺陷、合并请求或评论的网页地址。', en: 'The web page of this issue, merge request or comment.' } },
      ],
      values: ({ config, trigger }: EnvironmentInput<WeixinConfig>) => {
        const meta = trigger?.meta ?? {}
        const target: TargetKind = meta.target === 'merge_request' ? 'merge_request' : 'issue'
        const number = Number(meta.number)
        return {
          DSH_SUPERAGENT_WEIXIN_REPOSITORY: config.repository,
          DSH_SUPERAGENT_WEIXIN_ACCOUNT: str(meta.account),
          DSH_SUPERAGENT_WEIXIN_KIND: trigger ? target : '',
          DSH_SUPERAGENT_WEIXIN_NUMBER: number ? String(number) : '',
          DSH_SUPERAGENT_WEIXIN_WEB_URL: trigger ? str(trigger.url) || targetPage(config.repository, target, number) : '',
        }
      },
    },
  }
}

export const name = 'dsh-superagent-weixin'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  let source: SourceContext | undefined
  const kind = weixinKind(() => source?.config<WeixinConfig>(SOURCE))
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'weixin: source kind')
  ctx.effect(() => {
    source = sourceContext(ctx.orchestrator, kind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as Source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source?.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

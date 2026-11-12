import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { key, type Trigger } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import type { Health } from '../src/sources/host.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { findWeixin, issueTrigger, mergeTrigger, mentions, noteTrigger } from '../src/sources/weixin-trigger.ts'
import { sendWeixin } from '../src/sources/weixin-channel.ts'
import { weixinThreadContext } from '../src/sources/weixin-read.ts'
import { configured, pollFailure, pollRound, weixinKind, WeixinConfigSchema, type WeixinConfig } from '../src/sources/weixin.ts'
import { testDeployment } from './fixtures/deployment.ts'

const TOKEN = 'secret-private-key'
const dirs: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function config(overrides: Partial<WeixinConfig> = {}): WeixinConfig {
  const dir = mkdtempSync(join(tmpdir(), 'weixin-'))
  dirs.push(dir)
  const tokenFile = join(dir, 'token')
  writeFileSync(tokenFile, `${TOKEN}\n`)
  return WeixinConfigSchema.parse({ repository: 'acme/widgets', tokenFile, observeIssues: true, observePulls: true, observeComments: true,
    ...overrides })
}
const issue = {
  id: 101, iid: 7, title: 'Login fails', description: 'Please fix this', state: 'opened',
  created_at: '2026-11-12T02:00:00+0000', updated_at: '2026-11-12T02:00:00+0000',
  web_url: 'https://git.weixin.qq.com/acme/widgets/issues/7', author: { id: 1, username: 'alice', name: 'Alice' },
}
const merge = {
  id: 102, iid: 8, title: 'Fix login', description: 'Fixes the login', state: 'opened',
  created_at: '2026-11-12T02:00:00+0000', updated_at: '2026-11-12T02:00:00+0000',
  web_url: 'https://git.weixin.qq.com/acme/widgets/merge_requests/8', author: { id: 2, username: 'bob', name: 'Bob' },
}
const note = (id: number, body: string, at: string, author = 'bob', system = false) =>
  ({ id, body, created_at: at, system, noteable_type: 'Issue', author: { id: 3, username: author, name: author } })
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function stub(routes: (url: string, init?: RequestInit) => Response | undefined): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const result = routes(url, init)
    if (!result) throw new Error(`Unexpected URL ${url}`)
    return result
  }))
}
function fakeContext(config: WeixinConfig) {
  const state = new Map<string, unknown>()
  const received: Trigger[] = []
  const described: string[] = []
  const reports: Health[] = []
  const ctx = {
    ready: Promise.resolve(),
    configured: () => true,
    config: <C extends Record<string, unknown>>(id: string) => id === 'weixin' ? config as unknown as C : undefined,
    state: { get: (name: string) => state.get(name), set: (name: string, value: unknown) => {
      if (value === undefined) state.delete(name); else state.set(name, value) } },
    receive: async (trigger: Trigger) => { received.push(trigger); return 'stored' as const },
    threads: { describe: (key: string) => { described.push(key) } },
    report: (_entry: string, value: Health) => { reports.push(value) },
  } as unknown as SourceContext
  return { ctx, state, received, described, reports }
}
const triggerOf = () => issueTrigger(issue, 'acme/widgets', 'agent')

describe('weixin triggers', () => {
  it('builds stable issue, merge request and note triggers and drops notes that are not a person\'s words', () => {
    const opened = issueTrigger(issue, 'acme/widgets', 'agent')
    expect(opened.id).toBe(key('weixin-issue', 'acme/widgets', '7'))
    expect(opened.threads).toEqual([{ source: 'weixin', id: 'issue:7' }])
    expect(opened.actor).toEqual({ source: 'weixin', id: 'alice' })
    expect(opened.human).toBe(true)
    expect(opened.text).toBe('Login fails\n\nPlease fix this')
    expect(opened.channel).toEqual({ source: 'weixin', thread: 'weixin:issue:7',
      address: { target: 'issue', iid: '7', recordId: '101', repository: 'acme/widgets', url: issue.web_url } })
    expect(opened.meta).toEqual({ kind: 'issue', target: 'issue', number: 7, recordId: 101, repository: 'acme/widgets', account: 'agent' })
    expect(opened.addressed).toBeUndefined()

    const pull = mergeTrigger(merge, 'acme/widgets', 'agent')
    expect(pull.id).toBe(key('weixin-merge-request', 'acme/widgets', '8'))
    expect(pull.threads).toEqual([{ source: 'weixin', id: 'merge_request:8' }])
    expect(pull.channel!.thread).toBe('weixin:merge_request:8')

    const mentioned = noteTrigger(note(201, 'Hi @agent please', '2026-11-12T02:01:00+0000'), 'issue', 7, 101, 'acme/widgets', issue.web_url, 'agent')!
    expect(mentioned.id).toBe(key('weixin-note', 'acme/widgets', '201'))
    expect(mentioned.addressed).toBe('mention')
    expect(mentioned.threads).toEqual([{ source: 'weixin', id: 'issue:7' }])
    expect(mentioned.url).toBe(`${issue.web_url}#note_201`)
    expect(mentioned.meta).toEqual({ kind: 'note', target: 'issue', number: 7, recordId: 101, noteId: 201, repository: 'acme/widgets', account: 'agent' })
    const botNote = noteTrigger(note(205, 'nightly report', '2026-11-12T02:01:00+0000', 'project_1_bot'), 'issue', 7, 101,
      'acme/widgets', undefined, 'agent')!
    expect(botNote.human).toBe(false)

    expect(noteTrigger(note(202, 'state changed', '2026-11-12T02:01:00+0000', 'bob', true), 'issue', 7, 101, 'acme/widgets', undefined, 'agent')).toBeUndefined()
    expect(noteTrigger(note(203, 'my own note', '2026-11-12T02:01:00+0000', 'agent'), 'issue', 7, 101, 'acme/widgets', undefined, 'agent')).toBeUndefined()
    expect(noteTrigger(note(204, '', '2026-11-12T02:01:00+0000'), 'issue', 7, 101, 'acme/widgets', undefined, 'agent')).toBeUndefined()
  })

  it('recognizes a whole GitLab username, not a longer one that starts with it', () => {
    expect(mentions('hello @agent', 'agent')).toBe(true)
    expect(mentions('hello @agent.name', 'agent')).toBe(false)
    expect(mentions('hello @agent-name', 'agent')).toBe(false)
    expect(mentions('hello @agent.', 'agent')).toBe(true)
    expect(mentions('hello @AGENT', 'agent')).toBe(true)
  })

  it('finds issue and merge request threads by number and URL', () => {
    expect(findWeixin('#7')).toEqual({ threads: ['weixin:issue:7'], terms: [] })
    expect(findWeixin('!8')).toEqual({ threads: ['weixin:merge_request:8'], terms: [] })
    expect(findWeixin('8')).toEqual({ threads: ['weixin:issue:8', 'weixin:merge_request:8'], terms: [] })
    expect(findWeixin('https://git.weixin.qq.com/acme/widgets/merge_requests/8')).toEqual({ threads: ['weixin:merge_request:8'], terms: [] })
    expect(findWeixin('login fails')).toEqual({ threads: [], terms: [] })
  })
})

describe('weixin polling', () => {
  const routes = (notes: unknown[], extra = (_url: string) => undefined as Response | undefined) =>
    (url: string) => {
      if (url.endsWith('/user')) return response({ id: 9, username: 'agent' })
      if (url.includes('/projects/acme%2Fwidgets/issues?')) return response(url.includes('page=1') ? [issue] : [])
      if (url.includes('/projects/acme%2Fwidgets/merge_requests?')) return response([])
      if (url.includes('/projects/acme%2Fwidgets/issues/101/notes?')) return response(notes)
      return extra(url)
    }

  it('establishes a baseline on the first poll, then receives a new issue and only new notes', async () => {
    const c = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'weixin-'))
      dirs.push(dir)
      const tokenFile = join(dir, 'token')
      writeFileSync(tokenFile, TOKEN)
      return WeixinConfigSchema.parse({ repository: 'acme/widgets', tokenFile, observeIssues: true, observeComments: true })
    })()
    const notes = [note(201, 'old', '2026-11-12T01:00:00+0000'), note(202, 'new @agent', '2026-11-12T02:00:01+0000'),
      note(203, 'mine', '2026-11-12T02:00:02+0000', 'agent'), note(204, 'changed', '2026-11-12T02:00:03+0000', 'bob', true)]
    stub(routes(notes))
    const { ctx, state, received, described } = fakeContext(c)
    const signal = new AbortController().signal
    await pollRound(ctx, signal)
    expect(received).toEqual([])
    expect(state.get(KV.weixin.since('issues'))).toMatch(/^\d{4}-/)
    expect(described).toEqual([])

    state.set(KV.weixin.since('issues'), '2026-11-12T01:59:00.000Z')
    await pollRound(ctx, signal)
    expect(received.map(trigger => trigger.text)).toEqual(['Login fails\n\nPlease fix this', 'new @agent'])
    expect(received[1]!.addressed).toBe('mention')
    expect(described).toEqual(['weixin:issue:7'])
    expect(state.get(KV.weixin.note('issue:7'))).toBe(204)

    await pollRound(ctx, signal)
    expect(received).toHaveLength(2)
  })

  it('reports a failure only after the configured number of rounds', () => {
    expect(pollFailure(1, 3, new Error('network'))).toBeUndefined()
    expect(pollFailure(3, 3, new Error('network'))).toMatchObject({ state: 'error' })
  })

  it('sends the private key as a header and surfaces a rejected key', async () => {
    const settings = config()
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response({ message: '401 Unauthorized' }, 401))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx } = fakeContext(settings)
    await expect(pollRound(ctx, new AbortController().signal)).rejects.toMatchObject({ status: 401, message: '401 Unauthorized' })
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'PRIVATE-TOKEN': TOKEN })
  })

  it('knows when it names neither a project nor a key file', () => {
    const empty = WeixinConfigSchema.parse({})
    expect(configured(empty)).toBe(false)
    expect(configured({ ...empty, repository: 'a/b' })).toBe(false)
    expect(configured({ ...empty, repository: 'a/b', tokenFile: '/tmp/key' })).toBe(true)
  })
})

describe('weixin channel', () => {
  const message = { id: 'out-1', kind: 'reply' as const, text: 'Done', ticketId: 't1',
    channel: { source: 'weixin' as const, thread: 'weixin:issue:7',
      address: { target: 'issue', iid: '7', recordId: '101', repository: 'acme/widgets', url: 'https://git.weixin.qq.com/acme/widgets/issues/7' } } }

  it('posts a note with a marker and does not post it again when the marker is already there', async () => {
    const calls: string[] = []
    const first = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return url.includes('/notes?') ? response([]) : response({ id: 1 }, 201)
    })
    vi.stubGlobal('fetch', first)
    const settings = config()
    await expect(sendWeixin(message, settings)).resolves.toBe('sent')
    expect(calls[0]).toContain('per_page=100&page=1')
    const posted = JSON.parse((first.mock.calls.at(-1)![1] as RequestInit).body as string) as { body: string }
    expect(posted.body).toBe('Done\n\n<!-- dsh-superagent:out-1 -->')

    const second = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input)
      return url.includes('/notes?') ? response([{ id: 2, body: 'Done\n\n<!-- dsh-superagent:out-1 -->' }]) : response({})
    })
    vi.stubGlobal('fetch', second)
    await expect(sendWeixin(message, settings)).resolves.toBe('sent')
    expect(second.mock.calls.some(call => String(call[0]).includes('/notes?'))).toBe(true)
    expect(second.mock.calls.every(call => (call[1] as RequestInit | undefined)?.method !== 'POST')).toBe(true)
  })

  it('drops a reply only when the project is readable but the target is gone', async () => {
    const settings = config()
    stub(url => url.includes('/notes?') ? response({ message: '404 Not Found' }, 404) : response({}, 404))
    await expect(sendWeixin(message, settings)).rejects.toMatchObject({ status: 404 })

    stub(url => url.includes('/notes?') ? response({ message: '404 Not Found' }, 404) : response({ id: 1 }))
    await expect(sendWeixin(message, settings)).resolves.toBe('gone')

    stub(url => url.includes('/notes?') ? response({ message: '410 Gone' }, 410) : response({}))
    await expect(sendWeixin(message, settings)).resolves.toBe('gone')
  })

  it('links to the issue or merge request and labels it in the source\'s vocabulary', () => {
    const kind = weixinKind(() => config())
    expect(kind.channel!.link({ target: 'merge_request', iid: '8', repository: 'acme/widgets' }, {})).toEqual({
      url: 'https://git.weixin.qq.com/acme/widgets/merge_requests/8', label: { zh: '微信代码仓库 !8', en: 'WeChat code repository !8' } })
  })
})

describe('weixin context and policy', () => {
  it('reads the issue body and its notes, and names the note that the trigger came from', async () => {
    const settings = config()
    stub(url => {
      if (url.includes('/issues/101/notes?')) return response([note(201, 'first', '2026-11-12T02:01:00+0000')])
      if (url.endsWith('/issues/101')) return response(issue)
      return undefined
    })
    const trigger = noteTrigger(note(201, 'first', '2026-11-12T02:01:00+0000'), 'issue', 7, 101, 'acme/widgets', issue.web_url, 'agent')!
    expect(weixinThreadContext.messageId(trigger)).toBe('201')
    expect(weixinThreadContext.messageId(triggerOf())).toBe('issue:7')
    const page = await weixinThreadContext.read({} as Commands, trigger, 'thread', undefined, settings)
    expect(page.messages.map(message => message.text)).toEqual(['Login fails\n\nPlease fix this', 'first'])
    expect(page.next).toBeUndefined()
    const root = await weixinThreadContext.read({} as Commands, trigger, 'root', undefined, settings)
    expect(root.messages).toHaveLength(1)
    expect(root.messages[0]!.id).toBe('issue:7')
  })

  it('reads a merge request through its singular detail endpoint and its notes through the plural endpoint', async () => {
    const settings = config()
    const urls: string[] = []
    stub(url => {
      urls.push(url)
      if (url.includes('/merge_requests/102/notes?')) return response([note(301, 'looks good', '2026-11-12T02:01:00+0000')])
      if (url.endsWith('/merge_requests/102')) return response(merge)
      return undefined
    })
    const page = await weixinThreadContext.read({} as Commands, mergeTrigger(merge, 'acme/widgets', 'agent'), 'thread', undefined, settings)
    expect(page.messages.map(message => message.text)).toEqual(['Fix login\n\nFixes the login', 'looks good'])
    expect(urls.some(url => url.endsWith('/merge_requests/102'))).toBe(true)
    expect(urls.some(url => url.includes('/merge_requests/102/notes?'))).toBe(true)
  })

  it('scopes issues, merge requests and comments independently, and gives workers the source\'s own facts', () => {
    const settings = config({ observePulls: false })
    const kind = weixinKind(() => settings)
    expect(kind.scope!({ meta: { kind: 'issue' } }, settings)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(kind.scope!({ meta: { kind: 'merge_request' } }, settings)).toEqual({ listened: true, observed: false, row: 'pulls' })
    expect(kind.scope!({ meta: { kind: 'note' } }, settings)).toEqual({ listened: true, observed: true, row: 'comments' })
    expect(kind.scope!({ meta: {} }, settings)).toEqual({ listened: false, reason: 'unsupported_kind' })
    expect(kind.policy!.rows!(settings).map(row => [row.id, row.cells.unlistedUnaddressed])).toEqual([['issues', true], ['pulls', false], ['comments', true]])
    const trigger = issueTrigger(issue, 'acme/widgets', 'agent')
    expect(kind.environment!.values!({ deployment: testDeployment(), config: settings, trigger })).toEqual({
      DSH_SUPERAGENT_WEIXIN_REPOSITORY: 'acme/widgets',
      DSH_SUPERAGENT_WEIXIN_ACCOUNT: 'agent',
      DSH_SUPERAGENT_WEIXIN_KIND: 'issue',
      DSH_SUPERAGENT_WEIXIN_NUMBER: '7',
      DSH_SUPERAGENT_WEIXIN_WEB_URL: issue.web_url,
    })
  })
})

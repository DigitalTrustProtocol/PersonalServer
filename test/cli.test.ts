import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs, parseSubject, readEvents, runCli, toHexPubkey } from '../src/cli.js'
import { actor, tempDir, trustEvent } from './helpers.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function io() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}

describe('argument helpers', () => {
  it('parses flags and subjects', () => {
    expect(parseArgs(['roots', 'add', 'x', '--role', 'read', '--role=write', '--json']).flags.get('role')).toEqual(['read', 'write'])
    const a = actor()
    expect(toHexPubkey(a.npub)).toBe(a.pk)
    expect(parseSubject(a.npub)).toEqual({ type: 'p', value: a.pk })
    expect(parseSubject('user:id:1')).toEqual({ type: 'i', value: 'user:id:1' })
    expect(parseSubject(`e:${a.pk}`)).toEqual({ type: 'e', value: a.pk })
  })
})

describe('dtp-personal', () => {
  it('init creates config, database, and server key; settings commands write the settings table', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const t = io()
    expect(await runCli(['init', '--data-dir', dir, '--port', '39870', '--allow-origin', 'chrome-extension://abc'], t.io)).toBe(0)
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(config).toMatchObject({ listen: 'local', allowedOrigins: ['chrome-extension://abc'] })
    expect(config.admin.port).toBe(config.port + 1)
    expect(existsSync(join(dir, 'server.key'))).toBe(true)
    expect(existsSync(join(dir, 'personal.sqlite'))).toBe(true)

    const root = actor()
    expect(await runCli(['roots', 'add', root.npub, '--data-dir', dir], t.io)).toBe(0)
    const list = io()
    await runCli(['roots', 'list', '--data-dir', dir], list.io)
    expect(list.out).toEqual([`${root.pk} configured`])
    expect(await runCli(['relays', 'add', 'wss://relay.example', '--data-dir', dir], t.io)).toBe(0)
    expect(await runCli(['relays', 'add', 'http://nope', '--data-dir', dir], t.io)).toBe(1)
    expect(await runCli(['auth', 'writes', 'members', '--data-dir', dir], t.io)).toBe(0)
    expect(await runCli(['members', 'add', root.npub, '--role', 'admin', '--data-dir', dir], t.io)).toBe(0)
    const members = io()
    await runCli(['members', 'list', '--data-dir', dir], members.io)
    expect(members.out).toEqual([`${root.pk} admin`])
    expect(await runCli(['sync', 'stop', '--data-dir', dir], t.io)).toBe(0)
    expect(await runCli(['sync', 'strategy', 'frontier-interval', '30', '--data-dir', dir], t.io)).toBe(0)
    expect(await runCli(['sync', 'strategy', 'bogus', '--data-dir', dir], t.io)).toBe(1)
  })

  it('imports JSON Lines offline and exports signed winners', async () => {
    const dir = tempDir()
    dirs.push(dir)
    await runCli(['init', '--data-dir', dir, '--port', '39880'], io().io)
    const a = actor()
    const events = [
      await trustEvent(a, { subject: { type: 'p', value: actor().pk } }),
      await trustEvent(a, { subject: { type: 'p', value: actor().pk } }),
    ]
    const file = join(dir, 'in.jsonl')
    writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n${JSON.stringify({ ...events[0], sig: '00'.repeat(64) })}\n`)
    expect(readEvents(file)).toHaveLength(3)
    const imported = io()
    expect(await runCli(['import', file, '--data-dir', dir], imported.io)).toBe(0)
    expect(imported.out[0]).toMatch(/accepted: 2/)
    // The forged copy is refused by signature verification, before slot reduction.
    expect(imported.out[0]).toMatch(/invalid: 1/)
    const out = join(dir, 'out.jsonl')
    expect(await runCli(['export', '--out', out, '--data-dir', dir], io().io)).toBe(0)
    const exported = readEvents(out) as Array<{ id: string }>
    expect(exported.map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort())
  })
})

/**
 * Logging (operations.md § Logging): console plus rotating files
 * (10 × 10 MB). Info never logs subjects or message bodies; callers pass
 * counts and operation names only. Warn / error lines also feed the
 * telemetry Logs page.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LogLevel } from './config.js'

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_FILES = 10

export interface Logger {
  error(message: string): void
  warn(message: string): void
  info(message: string): void
  debug(message: string): void
}

export class ServerLogger implements Logger {
  readonly #level: LogLevel
  readonly #file: string | undefined
  readonly #sink: ((level: 'warn' | 'error', message: string) => void) | undefined
  readonly #console: boolean

  constructor(options: {
    level: LogLevel
    dir?: string
    console?: boolean
    sink?: (level: 'warn' | 'error', message: string) => void
  }) {
    this.#level = options.level
    this.#console = options.console !== false
    this.#sink = options.sink
    if (options.dir) {
      mkdirSync(options.dir, { recursive: true, mode: 0o700 })
      this.#file = join(options.dir, 'personal.log')
    }
  }

  #write(level: LogLevel, message: string): void {
    if (ORDER[level] > ORDER[this.#level]) return
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`
    if (this.#console) {
      if (level === 'error' || level === 'warn') console.error(line)
      else console.log(line)
    }
    if (this.#file) this.#append(line)
    if ((level === 'warn' || level === 'error') && this.#sink) this.#sink(level, message)
  }

  #append(line: string): void {
    const file = this.#file!
    try {
      if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) {
        rmSync(`${file}.${MAX_FILES - 1}`, { force: true })
        for (let i = MAX_FILES - 2; i >= 1; i -= 1) {
          if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`)
        }
        renameSync(file, `${file}.1`)
      }
      appendFileSync(file, `${line}\n`, { mode: 0o600 })
    } catch {
      // Logging must never take the server down.
    }
  }

  error(message: string): void {
    this.#write('error', message)
  }
  warn(message: string): void {
    this.#write('warn', message)
  }
  info(message: string): void {
    this.#write('info', message)
  }
  debug(message: string): void {
    this.#write('debug', message)
  }
}

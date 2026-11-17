/**
 * Daily check-in: scheduling, records and result classification.
 *
 * WorkBuddy's Buddy 加油站 gives a daily credit grant, but only when someone
 * actually presses the button on each account. This module owns the bookkeeping
 * around that: what happened today, for which account, and when the next attempt
 * is due. The HTTP call itself lives in upstream.js; keeping it separate means
 * the scheduler and its records can be tested without a gateway.
 *
 * Modelled on the Qoder connector's check-in support: records are per variant
 * AND per account, a day is only "settled" when an upstream actually claimed it,
 * failures stay retryable, and a manual run never treats today as settled — the
 * user asked for an attempt, so the upstream gets the last word.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile, writeJsonAtomic } from './auth.js'

/** Default check-in moment: 10:05 UTC+8, just after the daily window opens. */
export const DEFAULT_CHECKIN_MINUTE = 605

/** Most recent attempts kept per variant; older logs are dropped. */
const MAX_LOGS = 30

/** UTC+8 wall clock, used for "today" and for the configured moment. */
export function utc8WallClock(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600_000)
}

/** `YYYY-MM-DD` in UTC+8. */
export function utc8Date(nowMs = Date.now()) {
  return utc8WallClock(nowMs).toISOString().slice(0, 10)
}

/** Clamp a stored minute of day to one the scheduler can honour. */
export function normalizeCheckinMinute(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHECKIN_MINUTE
  const whole = Math.trunc(value)
  if (whole < 0 || whole > 1439) return DEFAULT_CHECKIN_MINUTE
  // Before 10:00 the upstream is still serving the previous day's window.
  return Math.max(600, whole)
}

/** Milliseconds until the next check-in moment (UTC+8). */
export function msUntilNextCheckin(minuteOfDay, nowMs = Date.now()) {
  const minute = normalizeCheckinMinute(minuteOfDay)
  const now = utc8WallClock(nowMs)
  const target = new Date(now.getTime())
  target.setUTCHours(Math.floor(minute / 60), minute % 60, 5, 0)
  let diff = target.getTime() - now.getTime()
  if (diff <= 0) {
    target.setUTCDate(target.getUTCDate() + 1)
    diff = target.getTime() - now.getTime()
  }
  return diff
}

/** Whether today's configured moment has passed (UTC+8). */
export function isPastCheckinTime(minuteOfDay, nowMs = Date.now()) {
  const minute = normalizeCheckinMinute(minuteOfDay)
  const now = utc8WallClock(nowMs)
  return now.getUTCHours() * 60 + now.getUTCMinutes() >= minute
}

/**
 * A day is settled only by a claimed result.
 *
 * "no-campaign", "before-window" and errors must stay retryable: one early
 * failure must not burn the whole day, which is the failure mode a once-a-day
 * scheduler otherwise has.
 */
export function isSettled(record, today, accountId, soleAccount) {
  if (record === undefined) return false
  const state = accountId === undefined ? undefined : record.accounts?.[accountId]
  if (state !== undefined) {
    return state.date === today && (state.status === 'claimed' || state.status === 'already-claimed')
  }
  // Records written before accounts were stored individually carry one header
  // row. It applies to the sole account only; with several, no guess is safe.
  if (soleAccount === true) {
    return record.date === today && (record.status === 'claimed' || record.status === 'already-claimed')
  }
  return false
}

/** A record's public shape: never copy a credential into the store. */
export function accountTag(account) {
  return {
    id: account.id ?? account.hash ?? '',
    ...account.nickname === undefined ? {} : { nickname: account.nickname },
    ...account.uidShort === undefined ? {} : { uidShort: account.uidShort },
  }
}

/**
 * Check-in records, one file for the whole plugin.
 *
 * Atomic writes through writeJsonAtomic: the scheduler runs in the background,
 * and a crash mid-write must not leave a half-written record that looks like a
 * missed day.
 */
export class CheckInStore {
  constructor(filePath) {
    this.filePath = filePath
  }

  readAll() {
    const parsed = readJsonFile(this.filePath)
    return parsed !== undefined && typeof parsed === 'object' ? parsed : {}
  }

  read(variantId) {
    return this.readAll()[variantId]
  }

  clearLogs(variantId) {
    const all = this.readAll()
    if (all[variantId] === undefined) return
    writeJsonAtomic(this.filePath, { ...all, [variantId]: { ...all[variantId], logs: [] } })
  }

  /** Record one result and prepend it to the (capped) log. */
  write(variantId, record) {
    const all = this.readAll()
    const log = {
      id: `${record.date}-${record.timestamp}-${record.account?.id ?? ''}`,
      date: record.date,
      timestamp: record.timestamp,
      status: record.status,
      ...record.amount === undefined ? {} : { amount: record.amount },
      ...record.message === undefined ? {} : { message: record.message },
      ...record.account === undefined ? {} : { account: record.account },
    }
    const logs = [log, ...(all[variantId]?.logs ?? []).filter(item => item.id !== log.id)].slice(0, MAX_LOGS)
    writeJsonAtomic(this.filePath, { ...all, [variantId]: { ...record, logs } })
    return log
  }
}

/** Create the store at the plugin's data dir. */
export function createCheckInStore(dataDir) {
  return new CheckInStore(join(dataDir, 'checkin-status.json'))
}

/** Read a raw record file, for diagnostics. */
export function readCheckInFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}


/**
 * Daily check-in scheduler.
 *
 * Modelled on Qoder's CheckInScheduler: one timer per variant, startup catch-up,
 * in-flight de-duplication, and a manual run that never treats today as settled.
 * The work per account is injected (`checkIn`), so no gateway is needed to test
 * the orchestration.
 */
export class CheckInScheduler {
  constructor(options) {
    this.targets = options.targets
    this.isEnabled = options.isEnabled ?? (() => true)
    this.store = options.store
    this.now = options.now ?? Date.now
    this.timers = new Map()
    this.inFlight = new Map()
    this.nextRuns = new Map()
    this.disposed = false
  }

  start() {
    if (this.disposed) return
    void this.sweepAll(true)
    this.rearm()
  }

  dispose() {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  rearm() {
    if (this.disposed) return
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.nextRuns.clear()
    const nowMs = this.now()
    for (const target of this.targets) {
      const delay = msUntilNextCheckin(target.minuteOfDay(), nowMs)
      this.nextRuns.set(target.variantId, nowMs + delay)
      const timer = setTimeout(() => {
        this.timers.delete(target.variantId)
        void this.sweepAll(false, target.variantId).finally(() => this.rearm())
      }, delay)
      timer.unref?.()
      this.timers.set(target.variantId, timer)
    }
  }

  /**
   * Check every enabled variant, or one when a timer fires.
   *
   * A day already claimed is left alone; no-campaign / errors stay retryable so
   * an early failure cannot burn the day. Accounts are checked one by one, and
   * one failing account never stops the others.
   */
  async sweepAll(isCatchUp, only) {
    if (this.disposed) return []
    const nowMs = this.now()
    const today = utc8Date(nowMs)
    const all = []
    for (const target of this.targets) {
      if (only !== undefined && target.variantId !== only) continue
      if (!this.isEnabled(target.variantId)) continue
      if (this.inFlight.has(target.variantId)) continue
      const run = this.#sweepOne(target, isCatchUp, nowMs, today)
      this.inFlight.set(target.variantId, run)
      try {
        all.push(...await run)
      } finally {
        this.inFlight.delete(target.variantId)
      }
    }
    return all
  }

  async #sweepOne(target, isCatchUp, nowMs, today) {
    const accounts = await target.accounts()
    const record = this.store.read(target.variantId)
    const sole = accounts.length === 1
    const outcomes = []
    for (const account of accounts) {
      if (this.disposed) break
      // On a catch-up sweep a claimed day is skipped. On a manual run the
      // upstream gets the last word — the user asked for an attempt.
      if (isCatchUp && isSettled(record, today, account.hash, sole)) continue
      try {
        const result = await target.checkIn(account)
        const normalized = {
          variantId: target.variantId,
          date: today,
          timestamp: nowMs,
          status: result.status,
          ...result.amount === undefined ? {} : { amount: result.amount },
          ...result.message === undefined ? {} : { message: result.message },
          account: accountTag(account),
        }
        this.#record(target.variantId, normalized)
        outcomes.push(normalized)
      } catch (error) {
        const normalized = {
          variantId: target.variantId, date: today, timestamp: nowMs,
          status: 'error', message: error instanceof Error ? error.message : String(error),
          account: accountTag(account),
        }
        this.#record(target.variantId, normalized)
        outcomes.push(normalized)
      }
    }
    return outcomes
  }

  /** Record a result, maintaining per-account settled state alongside the log. */
  #record(variantId, result) {
    const existing = this.store.read(variantId) ?? {}
    const accounts = { ...(existing.accounts ?? {}) }
    if (result.account?.id !== undefined && (result.status === 'claimed' || result.status === 'already-claimed')) {
      accounts[result.account.id] = { date: result.date, status: result.status }
    }
    this.store.write(variantId, {
      ...result,
      accounts,
    })
  }

  /**
   * Manual run: attempt every account for one variant, without the "already
   * settled today" short-circuit. Concurrent sweeps are awaited first.
   */
  async checkInNow(variantId) {
    const running = this.inFlight.get(variantId)
    if (running !== undefined) await running.catch(() => {})
    if (this.disposed) return []
    const target = this.targets.find(candidate => candidate.variantId === variantId)
    if (target === undefined) return []
    const nowMs = this.now()
    const today = utc8Date(nowMs)
    const accounts = await target.accounts()
    const outcomes = []
    for (const account of accounts) {
      try {
        const result = await target.checkIn(account)
        const normalized = {
          variantId, date: today, timestamp: nowMs, status: result.status,
          ...result.amount === undefined ? {} : { amount: result.amount },
          ...result.message === undefined ? {} : { message: result.message },
          account: accountTag(account),
        }
        this.#record(variantId, normalized)
        outcomes.push(normalized)
      } catch (error) {
        outcomes.push({
          variantId, date: today, timestamp: nowMs, status: 'error',
          message: error instanceof Error ? error.message : String(error),
          account: accountTag(account),
        })
      }
    }
    return outcomes
  }

  nextRunAt(variantId) {
    return this.nextRuns.get(variantId)
  }
}

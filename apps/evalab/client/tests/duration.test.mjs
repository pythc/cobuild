import assert from 'node:assert/strict'
import test from 'node:test'

const {
  agreedDuration,
  assessStart,
  attachDurationHours,
  attemptAccessibleAfterStartCloses,
  batchEnrollAllowed,
  descriptionDurationConflicts,
  durationProblemMessage,
  explicitDurationMentions,
  formatDateTime,
  formatDurationHours,
  formatRemain,
  isDurationHours,
  readDurationHours,
  windowPhase,
} = await import('../src/lib/format.ts')

const open = '2026-10-04T01:00:00.000Z'
const close = '2026-10-05T01:00:00.000Z'
const openMs = Date.parse(open)
const closeMs = Date.parse(close)

test('remaining time keeps hours above 24 instead of wrapping', () => {
  assert.equal(formatRemain(0), '00:00:00')
  assert.equal(formatRemain(-1), '00:00:00')
  assert.equal(formatRemain(24 * 60 * 60 * 1000), '24:00:00')
  assert.equal(formatRemain(25 * 60 * 60 * 1000), '25:00:00')
  assert.equal(formatRemain(48 * 60 * 60 * 1000 + 61 * 1000), '48:01:01')
  assert.equal(formatRemain(90 * 60 * 1000), '01:30:00')
})

test('the start window is open at the open instant and closed at the close instant', () => {
  assert.equal(windowPhase(openMs, open, close), 'open')
  assert.equal(windowPhase(openMs - 1, open, close), 'before')
  assert.equal(windowPhase(closeMs - 1, open, close), 'open')
  assert.equal(windowPhase(closeMs, open, close), 'closed')
  assert.equal(windowPhase(closeMs + 1, open, close), 'closed')
  assert.equal(windowPhase(openMs, 'not-a-date', close), 'unknown')
  assert.equal(windowPhase(openMs, close, open), 'unknown')
})

test('timestamps render as Beijing time', () => {
  assert.equal(formatDateTime('2026-01-15T16:05:00.000Z'), '2026/01/16 00:05')
  assert.equal(formatDateTime('2026-06-01T15:59:00.000Z'), '2026/06/01 23:59')
  assert.equal(formatDateTime(null), '—')
  assert.equal(formatDateTime('nope'), '—')
})

test('duration reads stay exact and never fall back to 24', () => {
  assert.equal(readDurationHours(undefined), null)
  assert.equal(readDurationHours(null), null)
  assert.equal(readDurationHours('24'), null)
  assert.equal(readDurationHours(24), 24)
  assert.equal(readDurationHours(48), 48)
  assert.equal(readDurationHours(36), 36)
  assert.equal(readDurationHours(Number.NaN), null)
  assert.equal(isDurationHours(24), true)
  assert.equal(isDurationHours(48), true)
  assert.equal(isDurationHours(36), false)
  assert.equal(formatDurationHours(48), '48 小时')
  assert.equal(formatDurationHours(undefined), '—')
  assert.equal(agreedDuration(undefined, 24), null)
  assert.equal(agreedDuration(48, null), 48)
  assert.equal(agreedDuration(48, 48), 48)
  assert.equal(agreedDuration(24, 48), null)
  assert.equal(agreedDuration(36, 36), null)
  const attached = attachDurationHours({ durationHours: 48 }, { id: 'e' })
  assert.equal(attached.durationHours, 48)
  assert.equal(attachDurationHours({ id: 'e' }, { id: 'e' }).durationHours, null)
})

test('start is allowed only for a confirmed 24 or 48 hour duration inside the window', () => {
  const base = {
    opensAt: open,
    startClosesAt: close,
    status: 'OPEN',
    enrollmentDurationHours: 48,
    batchDurationHours: 48,
  }
  assert.deepEqual(assessStart({ ...base, now: openMs }), { ok: true, durationHours: 48 })
  assert.equal(assessStart({ ...base, now: openMs - 1 }).ok, false)
  assert.equal(assessStart({ ...base, now: openMs - 1 }).message, '开始入口尚未开放。')
  assert.equal(assessStart({ ...base, now: closeMs }).message, '开考入口已关闭。')
  assert.equal(assessStart({ ...base, now: openMs, status: 'CLOSED' }).message, '该批次暂未开放开考。')
  assert.equal(assessStart({ ...base, now: openMs, status: 'DRAFT' }).ok, false)

  const missing = assessStart({
    ...base,
    now: openMs + 1000,
    enrollmentDurationHours: undefined,
    batchDurationHours: 24,
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.durationHours, null)
  assert.equal(missing.message, '考核时长无法确认，暂时不能开始。')

  const changed = assessStart({
    ...base,
    now: openMs,
    enrollmentDurationHours: 24,
    batchDurationHours: 48,
  })
  assert.equal(changed.ok, false)
  assert.equal(changed.message, '考核时长已变化，请刷新后再确认。')
  assert.equal(durationProblemMessage(24, 48), '考核时长已变化，请刷新后再确认。')
  assert.equal(durationProblemMessage(48, null), null)
})

test('future open batches can be enrolled while start stays closed until the window', () => {
  assert.equal(batchEnrollAllowed('OPEN'), true)
  assert.equal(batchEnrollAllowed(undefined), true)
  assert.equal(batchEnrollAllowed(''), true)
  assert.equal(batchEnrollAllowed('DRAFT'), false)
  assert.equal(batchEnrollAllowed('CLOSED'), false)
  const beforeOpen = assessStart({
    now: openMs - 60_000,
    opensAt: open,
    startClosesAt: close,
    status: 'OPEN',
    enrollmentDurationHours: 24,
    batchDurationHours: 24,
  })
  assert.equal(batchEnrollAllowed('OPEN'), true)
  assert.equal(beforeOpen.ok, false)
  assert.equal(attemptAccessibleAfterStartCloses('ACTIVE'), true)
  assert.equal(attemptAccessibleAfterStartCloses('FINALIZED'), true)
  assert.equal(attemptAccessibleAfterStartCloses('EXPIRED'), true)
  assert.equal(attemptAccessibleAfterStartCloses('READY'), false)
})

test('description warnings detect explicit 24 or 48 hour wording without rewriting it', () => {
  const original = '请在 24 小时内完成。2024 秋季共 24 人。'
  assert.deepEqual(explicitDurationMentions(original), [24])
  assert.equal(descriptionDurationConflicts(original, 48), true)
  assert.equal(descriptionDurationConflicts(original, 24), false)
  assert.equal(descriptionDurationConflicts(original, null), false)
  assert.equal(original, '请在 24 小时内完成。2024 秋季共 24 人。')
  assert.equal(descriptionDurationConflicts('限时48小时', 24), true)
  assert.equal(descriptionDurationConflicts('24小时或48小时均可', 24), true)
  assert.equal(descriptionDurationConflicts('48 hours', 48), false)
  assert.equal(descriptionDurationConflicts('48hours', 24), true)
  assert.equal(descriptionDurationConflicts('二十四小时', 48), false)
  assert.equal(descriptionDurationConflicts('24人', 48), false)
  assert.equal(descriptionDurationConflicts('', 24), false)
})

test('Beijing date input has a stable UTC instant and rejects normalized invalid dates', async () => {
  const { parseBeijingInput } = await import('../src/lib/format.ts')
  assert.equal(parseBeijingInput('2026-10-05 00:00'), '2026-10-04T16:00:00.000Z')
  assert.equal(parseBeijingInput('2026-02-30 00:00'), null)
  assert.equal(parseBeijingInput('2026-10-05 24:00'), null)
  assert.equal(parseBeijingInput(null), null)
})

test('central enrollment normalization retains the captured duration without a fallback', async () => {
  const { normalizeEnrollment } = await import('../src/lib/exam.ts')
  assert.equal(normalizeEnrollment({id:'example',state:'READY',durationHours:48}).durationHours, 48)
  assert.equal(normalizeEnrollment({id:'example',state:'READY'}).durationHours, null)
})

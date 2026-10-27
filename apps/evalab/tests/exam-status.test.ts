import assert from 'node:assert/strict'
import test from 'node:test'
import { canFinalize, finalizeChecks, normalizeEnrollment, writesOpen } from '../client/src/lib/exam.ts'
import type { Enrollment } from '../client/src/types.ts'

const now = Date.parse('2026-09-28T12:00:00Z')
const sha = 'a'.repeat(40)

function enrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  return normalizeEnrollment({
    id: 'ui-regression',
    state: 'ACTIVE',
    deadline: '2026-09-29T12:00:00Z',
    repository: {
      id: 'repository', url: 'https://github.com/example/project', branch: 'main', sha,
      message: 'Test fixture', author: 'Test', committedAt: new Date(now).toISOString(),
      confirmedAt: new Date(now).toISOString(),
    },
    materials: {
      id: 'materials', sha256: 'b'.repeat(64), repoSha: sha,
      receivedAt: new Date(now).toISOString(), clientCount: 1, fileCount: 1, coverage: 'export',
    },
    ...overrides,
  })!
}

for (const [name, missing] of [
  ['repository', { repository: null }],
  ['materials', { materials: null }],
  ['both submissions', { repository: null, materials: null }],
] as const) {
  test(`Missing ${name} blocks finalization without reporting a version conflict`, () => {
    const exam = enrollment(missing)
    assert.equal(canFinalize(exam, now), false)
    assert.equal(finalizeChecks(exam, now).some((item) => item.label.includes('与材料')), false)
    if (!exam.repository) assert.ok(finalizeChecks(exam, now).some((item) => !item.ok && item.label === '尚未锁定仓库 SHA'))
    if (!exam.materials) assert.ok(finalizeChecks(exam, now).some((item) => !item.ok && item.label === '尚未收到 MCP 材料'))
  })
}

test('Matching submissions permit finalization while the exam is active', () => {
  const exam = enrollment()
  assert.equal(canFinalize(exam, now), true)
  assert.equal(writesOpen(exam, now), true)
  assert.ok(finalizeChecks(exam, now).some((item) => item.ok && item.label === '仓库 SHA 与材料一致'))
})

test('A real repository/material version conflict remains visible and blocks finalization', () => {
  const exam = enrollment()
  exam.materials!.repoSha = 'c'.repeat(40)
  assert.equal(canFinalize(exam, now), false)
  assert.ok(finalizeChecks(exam, now).some((item) => !item.ok && item.label === '仓库 SHA 与材料不一致'))
})

for (const [name, closed] of [
  ['finalized', { state: 'FINALIZED', finalizedAt: new Date(now).toISOString() }],
  ['final receipt received before state refresh', { finalizedAt: new Date(now).toISOString() }],
  ['expired', { state: 'EXPIRED' }],
  ['exact deadline', { deadline: new Date(now).toISOString() }],
  ['past deadline', { deadline: new Date(now - 1).toISOString() }],
  ['not started', { state: 'READY' }],
] as const) {
  test(`${name} does not expose an active exam or permit finalization`, () => {
    const exam = enrollment(closed)
    assert.equal(writesOpen(exam, now), false)
    assert.equal(canFinalize(exam, now), false)
  })
}

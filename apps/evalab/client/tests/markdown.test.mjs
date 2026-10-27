import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const { window } = new JSDOM('')
globalThis.window = window
const { renderMarkdown } = await import('../src/lib/markdown.ts')
const parse = (text) => new JSDOM(renderMarkdown(text)).window.document

test('headings, emphasis, nested lists, blockquotes and tables render as elements', () => {
  const doc = parse('# 项目要求\n\n**重点**与*补充*\n\n1. 一级\n   - 二级\n\n> 注意截止时间\n\n| 功能 | 验收 |\n| --- | --- |\n| 检索 | 能找到文档 |')
  assert.equal(doc.querySelector('h1')?.textContent, '项目要求')
  assert.equal(doc.querySelector('strong')?.textContent, '重点')
  assert.equal(doc.querySelector('em')?.textContent, '补充')
  assert.ok(doc.querySelector('ol li ul li'))
  assert.ok(doc.querySelector('blockquote'))
  assert.equal(doc.querySelector('tbody td')?.textContent, '检索')
  assert.equal(doc.querySelector('.markdown-table')?.getAttribute('tabindex'), '0')
})

test('old plain text keeps line breaks without changing literal backslash-n', () => {
  const doc = parse('第一行\n第二行\\n保留')
  assert.equal(doc.querySelectorAll('br').length, 1)
  assert.ok(doc.body.textContent.includes('第二行\\n保留'))
})

test('fenced code is escaped and never executed', () => {
  const doc = parse('```html\n<script>alert(1)</script>\n<div>示例</div>\n```')
  assert.equal(doc.querySelector('pre code')?.textContent, '<script>alert(1)</script>\n<div>示例</div>\n')
  assert.equal(doc.querySelector('script'), null)
  assert.equal(doc.querySelector('pre code')?.className, 'language-html')
})

test('raw HTML, event handlers, forms, frames and SVG stay inert', () => {
  const doc = parse('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<iframe src="https://example.com"></iframe>\n<svg onload=alert(1)></svg>\n<form><input name=password></form>')
  assert.equal(doc.querySelector('script,img,iframe,svg,form,input'), null)
  assert.ok(doc.body.textContent.includes('<script>'))
})

test('unsafe URL protocols and entity encodings cannot become links or images', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'javascript&#x3a;alert(1)', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,AA==']) {
    const doc = parse(`[点此](${url})\n\n![图](${url})`)
    assert.equal(doc.querySelector('[href],[src]'), null, url)
  }
})

test('ordinary links and images work with safe navigation and no referrer', () => {
  const doc = parse('[说明](https://example.com/doc?a=1&b=2)\n\n![结构图](https://example.com/diagram.png "图示")')
  const link = doc.querySelector('a')
  assert.equal(link?.getAttribute('href'), 'https://example.com/doc?a=1&b=2')
  assert.equal(link?.getAttribute('target'), '_blank')
  assert.equal(link?.getAttribute('rel'), 'noopener noreferrer')
  assert.equal(doc.querySelector('img')?.getAttribute('loading'), 'lazy')
  assert.equal(doc.querySelector('img')?.getAttribute('referrerpolicy'), 'no-referrer')
})

test('empty and repeated renders never carry content across documents', () => {
  assert.equal(renderMarkdown(''), '')
  renderMarkdown('[a]: https://example.com/private\n\n[a]')
  assert.equal(parse('[a]').querySelector('a'), null)
})

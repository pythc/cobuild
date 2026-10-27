import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
const validateLink = markdown.validateLink.bind(markdown)
markdown.validateLink = (url) => validateLink(url)
  && !/^[\s\u0000-\u0020]*(?:data|file):/i.test(url)

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return renderer.renderToken(tokens, index, options)
}
const renderImage = markdown.renderer.rules.image!
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('loading', 'lazy')
  tokens[index].attrSet('referrerpolicy', 'no-referrer')
  return renderImage(tokens, index, options, env, renderer)
}
markdown.renderer.rules.table_open = () => '<div class="markdown-table" role="region" aria-label="表格" tabindex="0"><table>\n'
markdown.renderer.rules.table_close = () => '</table></div>\n'

/** Render only Markdown-generated elements. Never interpret embedded raw HTML. */
export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(markdown.render(source), {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's',
      'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div'],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt', 'loading', 'referrerpolicy',
      'class', 'start', 'role', 'tabindex'],
    ALLOW_DATA_ATTR: false,
  })
}

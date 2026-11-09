/**
 * Shared skill-detail modal: the centered card behind both the installed-skill
 * detail (DetailDrawer) and the market-skill detail (MarketDetailDrawer).
 *
 * It owns only the chrome — backdrop, header (icon, title, meta, actions,
 * enable switch, close), the expandable summary, the section bar with its
 * in-document search, and the scrolling body. Each caller owns its data,
 * actions and body content. Esc, the backdrop and the close button all dismiss.
 */
import { useEffect, useRef, useState } from 'react'
import { tt } from '../panel-helpers.ts'
import css from './panel.module.css'

/** Props for the shared detail modal. */
export interface DetailModalProps {
  /** Accessible name of the dialog. */
  label: string
  /** The avatar: an icon image or the letter tile. */
  icon: React.ReactNode
  /** The title line (name, badges). */
  title: React.ReactNode
  /** Small facts printed under the title. */
  meta?: React.ReactNode
  /** Action buttons under the title, primary first. */
  actions?: React.ReactNode
  /** Control left of the close button (the enable switch). */
  aside?: React.ReactNode
  /** One-paragraph summary, clamped until expanded. */
  description?: string
  /** Left half of the section bar: the section title or the tab strip. */
  bar?: React.ReactNode
  /** Right half of the section bar: the in-document search field. */
  search?: { value: string; onChange: (value: string) => void; placeholder: string }
  children: React.ReactNode
  onClose: () => void
  dataPart?: string
}

/** The centered skill-detail dialog. */
export function DetailModal({
  label,
  icon,
  title,
  meta,
  actions,
  aside,
  description,
  bar,
  search,
  children,
  onClose,
  dataPart,
}: DetailModalProps): React.JSX.Element {
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  // The expand control appears only when the summary is actually cut off; a
  // collapsed summary that fits needs no way to "expand" to itself.
  const descRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)

  useEffect(() => {
    closeBtnRef.current?.focus()
  }, [])

  useEffect(() => {
    const element = descRef.current
    if (element === null) return
    setClamped(element.scrollHeight > element.clientHeight + 1)
  }, [description])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => { window.removeEventListener('keydown', handleKeyDown) }
  }, [onClose])

  // A modal covers the whole GUI, so Tab must not reach the page behind it.
  const trapTab = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Tab' || cardRef.current === null) return
    const focusable = cardRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const active = document.activeElement
    if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && (active === first || !cardRef.current.contains(active))) {
      event.preventDefault()
      last.focus()
    }
  }

  return (
    <div className={css.modalLayer}>
      <div className={css.modalBackdrop} onClick={onClose} aria-hidden="true" />
      <aside
        ref={cardRef}
        className={css.modalCard}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-dsh-part={dataPart}
        onKeyDown={trapTab}
      >
        <div className={css.modalHeader}>
          <div className={css.modalIcon}>{icon}</div>
          <div className={css.modalHeadMain}>
            <h2 className={css.modalTitle}>{title}</h2>
            {meta !== undefined && <div className={css.modalMeta}>{meta}</div>}
            {actions !== undefined && <div className={css.modalActions}>{actions}</div>}
          </div>
          <div className={css.modalAside}>
            {aside}
            <button
              ref={closeBtnRef}
              type="button"
              className={css.modalClose}
              aria-label={tt('detail.close')}
              title={tt('detail.closeTooltip')}
              onClick={onClose}
              data-close=""
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {description !== undefined && description !== '' && (
          <div className={css.modalSummary}>
            <p ref={descRef} className={css.modalDesc} data-expanded={expanded ? '' : undefined}>
              {description}
            </p>
            {clamped && (
              <button
                type="button"
                className={css.modalExpand}
                aria-expanded={expanded}
                onClick={() => { setExpanded(current => !current) }}
              >
                {expanded ? tt('detail.collapse') : tt('detail.expand')}
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-flipped={expanded ? '' : undefined}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            )}
          </div>
        )}

        <div className={css.modalBar}>
          <div className={css.modalBarLeft}>{bar}</div>
          {search !== undefined && (
            <div className={css.modalSearchWrap}>
              <svg className={css.modalSearchIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.7" y2="16.7" />
              </svg>
              <input
                type="text"
                className={css.modalSearch}
                value={search.value}
                spellCheck={false}
                aria-label={search.placeholder}
                placeholder={search.placeholder}
                onChange={(event) => { search.onChange(event.target.value) }}
              />
              {search.value !== '' && (
                <button
                  type="button"
                  className={css.modalSearchClear}
                  aria-label={tt('detail.clearSearch')}
                  title={tt('detail.clearSearch')}
                  onClick={() => { search.onChange('') }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>

        <div className={css.modalBody}>{children}</div>
      </aside>
    </div>
  )
}

/** One item of a detail modal's overflow menu. */
export interface DetailMenuItem {
  key: string
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

/** The "..." overflow menu of a detail modal; renders nothing when empty. */
export function DetailMenu({ label, items }: { label: string; items: readonly DetailMenuItem[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (wrapperRef.current !== null && !wrapperRef.current.contains(event.target as Node)) setOpen(false)
    }
    // Capture phase: Escape closes the menu and stops there instead of also
    // dismissing the dialog behind it.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <div className={css.moreMenuWrapper} ref={wrapperRef}>
      <button
        type="button"
        className={css.modalSecondary}
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      <div className={`${css.actionDropdown}${open ? ` ${css.dropdownOpen}` : ''}`}>
        {items.map(item => (
          <button
            key={item.key}
            type="button"
            className={`${css.menuItem}${item.danger === true ? ` ${css.deleteItem}` : ''}`}
            data-danger={item.danger === true ? '' : undefined}
            disabled={item.disabled === true}
            onClick={() => { setOpen(false); item.onSelect() }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** One display block of a skill document. */
interface DocBlock {
  kind: 'heading' | 'bullet' | 'code' | 'table' | 'text' | 'rule'
  text: string
}

/**
 * Split document lines into display blocks.
 *
 * Ceiling: headings, list items, fenced code, table rows and horizontal rules
 * only — links, nested lists and blockquotes stay literal text, which is
 * honest for a read-only preview; reach for a real markdown renderer if a
 * skill needs more.
 */
function docBlocks(lines: readonly string[]): DocBlock[] {
  const blocks: DocBlock[] = []
  let fenced = false
  for (const raw of lines) {
    // HTML comments carry no reader value in a preview; markdown hides them too.
    // Only closed comments are dropped, so a stray `<!--` cannot swallow the
    // rest of the document.
    const line = raw.replace(/<!--[\s\S]*?-->/gu, '').replace(/\s+$/u, '')
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      blocks.push({ kind: 'code', text: line })
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/u.test(line)) {
      blocks.push({ kind: 'rule', text: '' })
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/u.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', text: heading[1]! })
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/u.exec(line)
    if (bullet !== null) {
      blocks.push({ kind: 'bullet', text: bullet[1]! })
      continue
    }
    // A markdown table row: keep the columns aligned instead of reflowing them.
    if (line.startsWith('|')) {
      blocks.push({ kind: 'table', text: line })
      continue
    }
    blocks.push({ kind: 'text', text: line })
  }
  return blocks
}

/** Wrap the search hits of one line in <mark>, leaving the rest as text. */
function markSegment(text: string, needle: string, key: number): React.ReactNode {
  if (needle === '') return text
  const haystack = text.toLowerCase()
  const parts: React.ReactNode[] = []
  let from = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={`${key}:${at}`} className={css.docMark}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

/**
 * Render one document line with its inline formatting: `**bold**` and
 * `` `code` ``, plus the search highlight inside both.
 *
 * Ceiling: emphasis and inline code only — links, images, nested lists and
 * blockquotes stay literal text, which is honest for a read-only preview;
 * reach for a real markdown renderer if a skill needs more.
 */
function inlineLine(text: string, needle: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/u)
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{markSegment(part.slice(2, -2), needle, index)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={index} className={css.docInlineCode}>{markSegment(part.slice(1, -1), needle, index)}</code>
    }
    return <span key={index}>{markSegment(part, needle, index)}</span>
  })
}

/**
 * The document body of a skill, filtered and highlighted by the section-bar
 * search. A non-empty query keeps only the lines that contain it.
 */
export function DocBody({ content, query, emptyText }: {
  content: string
  query: string
  emptyText: string
}): React.JSX.Element {
  const needle = query.trim().toLowerCase()
  const lines = content.split(/\r?\n/u)
  const matching = needle === ''
    ? lines
    : lines.filter(line => line.toLowerCase().includes(needle) && line.trim() !== '')
  if (matching.length === 0) return <p className={css.empty}>{emptyText}</p>

  return (
    <div className={css.doc}>
      {docBlocks(matching).map((block, index) => {
        if (block.kind === 'heading') {
          return <p key={index} className={css.docHeading}>{inlineLine(block.text, needle)}</p>
        }
        if (block.kind === 'bullet') {
          return <p key={index} className={css.docBullet}>{inlineLine(block.text, needle)}</p>
        }
        if (block.kind === 'code') {
          return <p key={index} className={css.docCode}>{markSegment(block.text, needle, index)}</p>
        }
        if (block.kind === 'table') {
          return <p key={index} className={css.docTable}>{inlineLine(block.text, needle)}</p>
        }
        if (block.kind === 'rule') {
          return <hr key={index} className={css.docRule} />
        }
        return block.text.trim() === ''
          ? <p key={index} className={css.docGap} />
          : <p key={index} className={css.docText}>{inlineLine(block.text, needle)}</p>
      })}
    </div>
  )
}

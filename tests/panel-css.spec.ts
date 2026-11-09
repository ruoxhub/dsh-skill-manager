import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const cssPath = resolve(process.cwd(), 'src/client/panel/panel.module.css')

describe('panel.module.css scrollbar selectors', () => {
  it('never mixes a bare class into a ::-webkit-scrollbar selector list', () => {
    const css = readFileSync(cssPath, 'utf8')
    const offenders: string[] = []

    for (const match of css.matchAll(/([^{}]+)\{/g)) {
      const selector = match[1].trim()
      if (!selector.includes('::-webkit-scrollbar')) continue
      if (selector.startsWith('@')) continue
      for (const part of selector.split(',')) {
        const trimmed = part.trim()
        // A bare class would receive the scrollbar rule's width/height and collapse.
        if (trimmed && !trimmed.includes('::')) offenders.push(trimmed)
      }
    }

    expect(offenders).toEqual([])
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const cssPath = resolve(process.cwd(), 'src/client/panel/panel.module.css')
const componentPath = resolve(process.cwd(), 'src/client/panel/SkillsTab.tsx')

function declarations(css: string, selector: string): Record<string, string> {
  const match = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))
  expect(match?.[1], `missing .${selector} rule`).toBeDefined()
  return Object.fromEntries(
    match![1].split(';').flatMap((declaration) => {
      const [property, value] = declaration.split(':').map(part => part.trim())
      return property && value ? [[property, value]] : []
    }),
  )
}

describe('skill card name layout', () => {
  it('keeps badges and controls on their own row below the name', () => {
    const css = readFileSync(cssPath, 'utf8')
    const component = readFileSync(componentPath, 'utf8')
    const card = component.slice(component.indexOf('<div className={css.cardBody}>'))

    expect(card.indexOf('css.skillName')).toBeLessThan(card.indexOf('css.rowControls'))
    expect(card.indexOf('css.rowControls')).toBeLessThan(card.indexOf('css.cardActions'))
    expect(declarations(css, 'cardHeader')['flex-wrap']).toBe('wrap')
    expect(declarations(css, 'skillName').flex).toBe('1 1 100%')
    expect(declarations(css, 'rowControls').flex).toBe('1 1 100%')
  })

  it('does not let hidden actions reserve the width the badges need', () => {
    const css = readFileSync(cssPath, 'utf8')

    expect(declarations(css, 'badgeContainer').flex).toBe('1')
    expect(declarations(css, 'cardActions').flex).toBe('none')
    expect(css).toContain('.cardActions > * {\n  display: none;\n}')
    expect(css).toContain('.skillRow.cardMenuOpen .cardActions > * {\n  display: inline-flex;\n}')
  })

  it('keeps the enable switch visible outside the hover-only action group', () => {
    const css = readFileSync(cssPath, 'utf8')
    const component = readFileSync(componentPath, 'utf8')
    const card = component.slice(component.indexOf('<div className={css.cardBody}>'))
    const actions = card.indexOf('css.cardActions')
    const closer = card.indexOf('            </div>\n', actions)
    const switchNode = card.indexOf('css.switch', actions)
    const controlsCloser = card.indexOf('          </div>\n', switchNode)

    expect(switchNode).toBeGreaterThan(closer)
    expect(switchNode).toBeLessThan(controlsCloser)
    expect(css).toContain('.cardActions > * {\n  display: none;\n}')
  })
})

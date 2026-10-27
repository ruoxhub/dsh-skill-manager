/**
 * Test-environment glue shared by the family's vitest setups.
 *
 * Browser-module loader: the @deepseek-ai client half bundles are closure
 * factories registered through window.__ModuleLoader__ (the GUI's module
 * system). Under vitest there is no real loader, so this setup provides a
 * minimal one: factory(require) executes with a require backed by Node's
 * resolver (Node >=22.12 can require ESM). The module's exports are the
 * factory's return value (the closure's own module.exports).
 *
 * Storage global: Node 25 defines `localStorage` on the global object, and
 * without a usable `--localstorage-file` its getter returns an empty object —
 * `getItem`, `setItem` and `clear` are all missing, and Node warns about the
 * path. Vitest's jsdom environment fills in globals only where the name is
 * still free, and under vitest `window` is `globalThis`, so that stub survives
 * and every spec which touches storage exercises the degraded path instead of
 * the code under test: on Node 25 a package measures lower coverage than the
 * same tree does on Node 22, and specs that pass on Node 22 fail.
 *
 * A DOM environment therefore gets a usable Storage, and a run without a DOM
 * has the stub removed, which is what Node 22 leaves behind.
 */
import { createRequire } from 'node:module'

interface LoaderEntry {
  id: string
  factory: (require: (spec: string) => unknown) => unknown
}

const nodeRequire = createRequire(import.meta.url)
const modules = new Map<string, { exports: unknown }>()

function req(spec: string): unknown {
  const cached = modules.get(spec)
  if (cached) return cached.exports
  return nodeRequire(spec)
}

const loader = {
  load(entry: LoaderEntry): unknown {
    const cached = modules.get(entry.id)
    if (cached) return cached.exports
    // Register the placeholder first so circular factory requires resolve.
    const module = { exports: {} as unknown }
    modules.set(entry.id, module)
    module.exports = entry.factory(req) ?? module.exports
    return module.exports
  },
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__ModuleLoader__', {
    value: loader,
    configurable: true,
    writable: true,
  })
}

/** The Storage a DOM environment would have provided. */
class MemoryStorage implements Pick<Storage, 'length' | 'clear' | 'getItem' | 'key' | 'removeItem' | 'setItem'> {
  private readonly entries = new Map<string, string>()

  get length(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }

  setItem(key: string, value: string): void {
    this.entries.set(String(key), String(value))
  }
}

if (typeof globalThis.localStorage?.getItem !== 'function') {
  if (typeof document === 'undefined') {
    delete (globalThis as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    })
  }
}

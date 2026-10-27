// The shared setup carries the storage repair Node 25 needs and the
// browser-module loader: a jsdom environment only provides localStorage where
// Node has not already defined one, and Node 25 defines an empty stub.
import './shared/vitest.setup.ts'

// React 18 act() requires the act-environment flag; without it every act call
// in panel interaction tests warns (and the warning pollutes CI output).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export {}

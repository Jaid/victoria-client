import type {Linter} from 'eslint'

import {makeEslintConfig} from 'eslint-config-jaid'

const config: Array<Linter.Config> = [
  ...makeEslintConfig(),
  {
    files: ['docs/tldw/**/*.ts'],
    rules: {
      // Usage snippets keep visual section breaks around their explanatory comments.
      'stylistic/padding-line-between-statements': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Keep fixture construction and awaited reports adjacent to their assertions.
      'unicorn/no-unreadable-new-expression': 'off',
      'unicorn/no-await-expression-member': 'off',
      // Bun’s asynchronous .rejects matcher is typed as void in some overloads.
      'typescript/await-thenable': 'off',
    },
  },
]
export default config

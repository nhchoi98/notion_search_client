module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
    project: './tsconfig.app.json',
  },
  settings: {
    react: {
      version: '19',
    },
  },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh', 'react-compiler'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'plugin:react-refresh/recommended',
    'prettier',
  ],
  rules: {
    'react-refresh/only-export-components': 'warn',
    'react-compiler/react-compiler': 'warn',
    'no-empty-pattern': 'off',
  },
};

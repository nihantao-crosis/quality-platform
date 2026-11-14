import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // src/__audit_scratch__ 与 .claude/ 是审查/复审代理的临时目录(已 gitignore),本机 lint 不应跑到它们(fix2609n G24e)
  { ignores: ['dist', 'src-tauri/target', 'node_modules', 'src/__audit_scratch__', '.claude'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // SVG 图表大量使用 non-null 断言与索引访问，放宽噪声规则
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);

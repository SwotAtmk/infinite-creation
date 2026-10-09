/** @type {import('tailwindcss').Config} */
import path from 'node:path';
import { createRequire } from 'node:module';
import { heroui } from '@heroui/react';

const require = createRequire(import.meta.url);

// pnpm 布局下 @heroui/theme 只是间接依赖，根目录并不存在 node_modules/@heroui/theme，
// 若照官方文档直接写 './node_modules/@heroui/theme/dist/**'，Tailwind 会匹配到 0 个文件，
// 导致 HeroUI 组件自身的类（inline-flex / bg-primary / rounded-medium ...）全部缺失、页面丢失样式。
// 解决：从 @heroui/react 内部解析出 theme 的真实安装目录，转成绝对路径交给 Tailwind 扫描。
function herouiThemeContent() {
  try {
    const reactEntry = require.resolve('@heroui/react');
    const themeEntry = require.resolve('@heroui/theme', { paths: [reactEntry] });
    return path.join(path.dirname(themeEntry), '**/*.{js,mjs,ts,jsx,tsx}');
  } catch {
    // 兜底：npm/yarn 的扁平 node_modules 结构
    return './node_modules/@heroui/theme/dist/**/*.{js,mjs,ts,jsx,tsx}';
  }
}

export default {
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    herouiThemeContent(),
  ],
  darkMode: 'class',
  theme: {
    extend: {},
  },
  plugins: [
    heroui({
      themes: {
        light: {
          colors: {
            primary: { DEFAULT: '#2f6feb', foreground: '#ffffff' },
          },
        },
        dark: {
          colors: {
            primary: { DEFAULT: '#4f86ff', foreground: '#0b1220' },
          },
        },
      },
    }),
  ],
};

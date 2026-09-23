import { defineConfig } from 'tsup';

/**
 * 生产构建：工作区包 @shanhai/* 的入口指向 .ts 源码（供 tsx 开发直接使用），
 * 纯 Node 运行时无法加载，因此必须把它们打进产物；node:sqlite 由运行时内置，
 * 其余已安装的运行时依赖继续外置。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  noExternal: [/^@shanhai\//],
  external: ['sqlite']
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version?: string };

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __MELIES_VERSION__: JSON.stringify(pkg?.version ?? '0.0.0'),
  },
  server: {
    proxy: {
      '/export': {
        target: 'http://localhost:5174',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:5174',
        changeOrigin: true,
      },
    },
  },
  build: {
    copyPublicDir: false,
    assetsInlineLimit: 0,
    lib: {
      entry: 'src/lib/index.ts',
      name: 'MeliesVideoEditor',
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
    },
    cssCodeSplit: false,
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        '@xzdarcy/react-timeline-editor',
        'antd',
        '@ant-design/icons',
        '@dnd-kit/core',
        'howler',
        'lodash',
        'lottie-web',
      ],
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) return 'style.css';
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});

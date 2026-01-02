import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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

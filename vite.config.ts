import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // @ffmpeg/ffmpeg uses worker/wasm internals that confuse the dep optimizer.
    // Excluding keeps it in normal ESM graph and prevents missing optimized worker stubs.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/core', '@ffmpeg/util'],
  },
  server: {
    headers: {
      // FFmpeg.wasm (fast path) requires SharedArrayBuffer, which requires crossOriginIsolated.
      // In dev, we enable it via COOP/COEP headers.
      // NOTE: In production you must also serve these headers (or COEP: credentialless) for proxies to work.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
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

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BUILD_SHA = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VITE_BUILD_SHA ?? 'local';
const BUILD_ENV = process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? 'development';

/**
 * Splits heavy vendors into stable, separately cached chunks. Keeping each
 * chunk well below Rollup's single-chunk memory peak keeps Railway builders
 * comfortably inside their memory budget.
 */
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('/pdfjs-dist/')) return 'pdf-vendor';
  if (id.includes('/gsap/') || id.includes('/@studio-freight/lenis/')) return 'gsap-vendor';
  if (
    id.includes('/three/') ||
    id.includes('/three-stdlib/') ||
    id.includes('/@react-three/') ||
    id.includes('/postprocessing/') ||
    id.includes('/maath/') ||
    id.includes('/troika-') ||
    id.includes('/camera-controls/') ||
    id.includes('/meshline/') ||
    id.includes('/stats-gl/')
  ) {
    return 'three-vendor';
  }
  if (
    id.includes('/react/') ||
    id.includes('/react-dom/') ||
    id.includes('/scheduler/') ||
    id.includes('/zustand/') ||
    id.includes('/use-sync-external-store/')
  ) {
    return 'react-vendor';
  }
  return undefined;
}

/** Mirrors NGINX's /healthz in `vite dev` and `vite preview` so telemetry works locally. */
function healthz(): Plugin {
  const handler = (port: number) => (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => {
    if (req.url?.split('?')[0] !== '/healthz') return next();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ status: 'ok', service: 'portfolio', port: String(port), time: new Date().toISOString() }));
  };
  return {
    name: 'portfolio-healthz',
    configureServer(server) {
      server.middlewares.use(handler(server.config.server.port ?? 5173));
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler(server.config.preview.port ?? 4173));
    },
  };
}

export default defineConfig({
  plugins: [react(), healthz()],
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_ENV__: JSON.stringify(BUILD_ENV),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  optimizeDeps: {
    include: ['three', '@react-three/fiber', '@react-three/drei', 'gsap', '@studio-freight/lenis'],
  },
});

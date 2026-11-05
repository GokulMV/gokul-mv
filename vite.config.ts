import { defineConfig, type Plugin } from 'vite';

const BUILD_SHA = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VITE_BUILD_SHA ?? 'local';
const BUILD_ENV = process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? 'development';

/** Mirrors NGINX's /healthz in `vite dev` and `vite preview`. */
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
  plugins: [healthz()],
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
    reportCompressedSize: false,
  },
});

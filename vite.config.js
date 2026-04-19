import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Retire les attributs crossorigin du HTML produit.
// Nécessaire tant que le serveur n'a pas HTTPS — les navigateurs qui
// forcent HTTPS génèrent sinon des erreurs CORS fatales.
function removeCrossOrigin() {
  return {
    name: 'remove-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, '');
    },
  };
}

export default defineConfig({
  plugins: [react(), removeCrossOrigin()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    // Pas de crossorigin sur les scripts pour éviter les CORS via reverse proxy
    crossOriginLoading: false,
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/utils/**/*.test.js'],
  }
})

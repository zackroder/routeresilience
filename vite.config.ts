import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    root: path.resolve(__dirname, 'src/client'),
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: path.resolve(__dirname, 'dist/client'),
        emptyOutDir: true,
    },
});

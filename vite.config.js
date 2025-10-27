// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/Web-Architecture/',                // your repo name
  assetsInclude: ['**/*.asc', '**/*.geojson'] // ensure Vite treats these as assets
});

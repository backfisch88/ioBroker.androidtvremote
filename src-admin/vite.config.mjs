import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { moduleFederationShared } from '@iobroker/gui-components/modulefederation.admin.config.js';
import pack from './package.json' with { type: 'json' };

export default {
  plugins: [
    federation({
      name: 'ConfigCustomAndroidTvRemoteSet',
      filename: 'customComponents.js',
      exposes: { './Components': './src/Components.tsx' },
      remotes: {},
      shared: moduleFederationShared(pack),
      dts: false,
      manifest: false,
    }),
    react(),
  ],
  base: './',
  build: { target: 'chrome89', outDir: '../admin/custom', emptyOutDir: true },
};

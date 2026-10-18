import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

// Regenerate icons with: npx pwa-assets-generator
export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, resizeOptions: { background: '#0a0a0a' } },
    apple: { ...minimal2023Preset.apple, resizeOptions: { background: '#0a0a0a' } },
  },
  images: ['public/favicon.svg'],
})

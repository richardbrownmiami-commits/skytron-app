import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function fixFileProtocol() {
  return {
    name: 'fix-file-protocol',
    transformIndexHtml(html) {
      return html
        .replace(/ crossorigin/g, '')
        .replace(/type="module"/g, 'defer')
    }
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), fixFileProtocol()],
})

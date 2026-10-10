import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const port = Number(process.env.PORT || 4000);
createApp().listen(port, () => {
  console.log(`GD Arena API: http://localhost:${port}/api/health`);
  console.info('[alex-tts]', JSON.stringify({
    event: 'configuration',
    provider: 'elevenlabs',
    configured: Boolean(process.env.ELEVENLABS_API_KEY?.trim()),
    model: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
  }));
});

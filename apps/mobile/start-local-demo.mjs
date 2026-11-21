import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const expo = fileURLToPath(new URL('./node_modules/expo/bin/cli', import.meta.url));
const metro = spawn(process.execPath, [expo, 'start', '--localhost', '--port', '8081'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    EXPO_PUBLIC_API_URL: 'http://127.0.0.1:3000',
    EXPO_PUBLIC_TRUCKER_LOCAL_DEMO: '1',
  },
});
metro.on('exit', (code) => {
  process.exitCode = code ?? 1;
});

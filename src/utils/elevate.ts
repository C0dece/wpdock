/**
 * elevate.ts — runs shell commands with UAC elevation on Windows.
 * Uses temp files to avoid all command-line escaping issues.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Run a cmd/bat command elevated (UAC on Windows).
 * Writes `cmd` to a temp .bat file so no escaping is needed.
 * Returns true if the process exited with code 0.
 */
export function runElevated(cmd: string): Promise<boolean> {
  if (os.platform() === 'win32') {
    return new Promise(resolve => {
      const tmpBat = path.join(os.tmpdir(), `wpdock-${Date.now()}.bat`);
      try {
        fs.writeFileSync(tmpBat, `@echo off\r\n${cmd}\r\n`, 'utf-8');
      } catch {
        resolve(false);
        return;
      }

      // Single-quoted PS string: double-quotes inside are literal chars, no PS escaping
      const proc = cp.spawn(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `Start-Process cmd -ArgumentList '/c "${tmpBat}"' -Verb RunAs -Wait -WindowStyle Hidden`,
        ],
        { stdio: 'ignore', windowsHide: true }
      );
      proc.on('exit', code => {
        try { fs.unlinkSync(tmpBat); } catch { /* ok */ }
        resolve(code === 0);
      });
      proc.on('error', () => {
        try { fs.unlinkSync(tmpBat); } catch { /* ok */ }
        resolve(false);
      });
    });
  }

  return new Promise(resolve => {
    const proc = cp.spawn('sh', ['-c', cmd], { stdio: 'ignore' });
    proc.on('exit', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Run a PowerShell script elevated (UAC on Windows).
 * Writes `script` to a temp .ps1 file so no escaping is needed.
 * Returns true if the process exited with code 0.
 */
export function runElevatedPs(script: string): Promise<boolean> {
  if (os.platform() !== 'win32') {
    return Promise.resolve(false);
  }

  return new Promise(resolve => {
    const tmpPs1 = path.join(os.tmpdir(), `wpdock-${Date.now()}.ps1`);
    try {
      fs.writeFileSync(tmpPs1, script, 'utf-8');
    } catch {
      resolve(false);
      return;
    }

    const proc = cp.spawn(
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${tmpPs1}"' -Verb RunAs -Wait -WindowStyle Hidden`,
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    proc.on('exit', code => {
      try { fs.unlinkSync(tmpPs1); } catch { /* ok */ }
      resolve(code === 0);
    });
    proc.on('error', () => {
      try { fs.unlinkSync(tmpPs1); } catch { /* ok */ }
      resolve(false);
    });
  });
}

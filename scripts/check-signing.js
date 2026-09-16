const required = process.env.RELEASE_SIGNING_REQUIRED === '1';
const missing = [];
if (required && process.platform === 'win32' && !process.env.WINDOWS_CERTIFICATE_FILE) missing.push('WINDOWS_CERTIFICATE_FILE');
if (required && process.platform === 'darwin') {
  for (const name of ['MACOS_CERTIFICATE_BASE64', 'MACOS_CERTIFICATE_PASSWORD', 'MACOS_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[name]) missing.push(name);
  }
}
if (missing.length) throw new Error(`Release signing is required but missing: ${missing.join(', ')}`);
console.log(required ? `Signing configuration detected for ${process.platform}.` : 'Unsigned build mode is allowed.');

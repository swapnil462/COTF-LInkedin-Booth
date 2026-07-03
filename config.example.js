// Copy this file to config.js and fill in your values before running the app.
// config.js is intentionally excluded from version control.

const CONFIG = {
  // From: supabase.com → your project → Settings → API → Project URL
  SUPABASE_URL: 'https://your-project-ref.supabase.co',

  // From: supabase.com → your project → Settings → API → anon / public key
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',

  // lit-dash's Supabase project + anon key, reused only to call its existing
  // send-email edge function (SendGrid "custom" email type) so the booth
  // doesn't need its own SendGrid key.
  LITDASH_SUPABASE_URL: 'https://your-litdash-project-ref.supabase.co',
  LITDASH_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
};

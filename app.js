/* ─────────────────────────────────────────────────────────────────────────
   COTF Photo Booth — app.js
   State machine: form → camera → preview → thankyou → (reset → form)
   Supabase: 2-step (upload photo to Storage, then INSERT row via REST API)
   Retry: up to 2 retries with 1.5s delay; failed uploads queued in localStorage
───────────────────────────────────────────────────────────────────────── */

'use strict';

/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
  name: '',
  email: '',
  phone: '',
  photoDataUrl: null,   // full data:image/jpeg;base64,... string
  countdownTimer: null,
  countdownInterval: null,
  cameraStream: null,
  cameraCountdownInterval: null, // auto-capture countdown
};

/* ── DOM refs ─────────────────────────────────────────────────────────────── */
const screens = {
  form:     document.getElementById('screen-form'),
  camera:   document.getElementById('screen-camera'),
  preview:  document.getElementById('screen-preview'),
  thankyou: document.getElementById('screen-thankyou'),
};

// Form
const fieldName  = document.getElementById('field-name');
const fieldEmail = document.getElementById('field-email');
const fieldPhone = document.getElementById('field-phone');
const errorName  = document.getElementById('error-name');
const errorEmail = document.getElementById('error-email');
const errorPhone = document.getElementById('error-phone');
const btnContinue = document.getElementById('btn-continue');

// Camera
const cameraVideo   = document.getElementById('camera-video');
const btnCameraBack = document.getElementById('btn-camera-back');
const btnCapture    = document.getElementById('btn-capture');
const cameraHint    = document.getElementById('camera-hint');
const cameraCountdown = document.getElementById('camera-countdown');
const cameraError   = document.getElementById('camera-error');
const cameraErrorText = document.getElementById('camera-error-text');
const captureCanvas = document.getElementById('capture-canvas');

// Preview
const previewImg  = document.getElementById('preview-img');
const btnRetake   = document.getElementById('btn-retake');
const btnSubmit   = document.getElementById('btn-submit');
const submitLabel  = document.getElementById('submit-label');
const submitSpinner = document.getElementById('submit-spinner');
const submitIcon   = document.getElementById('submit-icon');

// Thank you
const thankyouName    = document.getElementById('thankyou-name');
const countdownArc    = document.getElementById('countdown-arc');
const countdownNumber = document.getElementById('countdown-number');

const toastEl = document.getElementById('toast');

/* ── Toast ────────────────────────────────────────────────────────────────── */
let toastTimeout = null;

function showToast(message, type = '', duration = 4000) {
  toastEl.textContent = message;
  toastEl.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove('show');
  }, duration);
}

/* ── Screen transitions ───────────────────────────────────────────────────── */
let currentScreen = 'form';

function showScreen(name) {
  const leaving = screens[currentScreen];
  const entering = screens[name];
  if (!entering || currentScreen === name) return;

  leaving.classList.add('exit');
  leaving.classList.remove('active');

  setTimeout(() => {
    leaving.classList.remove('exit');
    entering.classList.add('active');
    currentScreen = name;
  }, 300);
}

/* ════════════════════════════════════════════════════════════════════════════
   SCREEN 1 — FORM
════════════════════════════════════════════════════════════════════════════ */
const validators = {
  name(v)  { return v.trim().length >= 2; },
  email(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()); },
  phone(v) { return /^[\d\s\+\-\(\)]{7,15}$/.test(v.trim()); },
};

const errorMessages = {
  name:  'Please enter your full name',
  email: 'Please enter a valid email address',
  phone: 'Please enter a valid phone number',
};

function validateField(fieldEl, errorEl, key) {
  const val = fieldEl.value;
  const valid = validators[key](val);
  fieldEl.classList.toggle('error', !valid && val.length > 0);
  fieldEl.classList.toggle('valid', valid);
  errorEl.textContent = (!valid && val.length > 0) ? errorMessages[key] : '';
  return valid;
}

function checkFormValidity() {
  const ok =
    validators.name(fieldName.value) &&
    validators.email(fieldEmail.value) &&
    validators.phone(fieldPhone.value);
  btnContinue.disabled = !ok;
  btnContinue.setAttribute('aria-disabled', String(!ok));
}

fieldName.addEventListener('input',  () => { validateField(fieldName,  errorName,  'name');  checkFormValidity(); });
fieldEmail.addEventListener('input', () => { validateField(fieldEmail, errorEmail, 'email'); checkFormValidity(); });
fieldPhone.addEventListener('input', () => { validateField(fieldPhone, errorPhone, 'phone'); checkFormValidity(); });

btnContinue.addEventListener('click', () => {
  // Final validation pass
  const nameOk  = validateField(fieldName,  errorName,  'name');
  const emailOk = validateField(fieldEmail, errorEmail, 'email');
  const phoneOk = validateField(fieldPhone, errorPhone, 'phone');
  if (!nameOk || !emailOk || !phoneOk) return;

  state.name  = fieldName.value.trim();
  state.email = fieldEmail.value.trim();
  state.phone = fieldPhone.value.trim();

  startCamera();
});

/* ════════════════════════════════════════════════════════════════════════════
   SCREEN 2 — CAMERA
════════════════════════════════════════════════════════════════════════════ */
async function startCamera() {
  showScreen('camera');
  cameraError.hidden = true;
  cameraHint.textContent = 'Starting camera…';

  // Stop any existing stream first
  stopCamera();

  // Cascade from strict → loose constraints so any device works.
  // `ideal` is non-binding — the browser gives its closest/max supported
  // value rather than failing, so asking for more than older hardware can
  // do is free (iPad Safari just clamps to its own ceiling).
  // focusMode/exposureMode/whiteBalanceMode are non-standard and only
  // honored on Chrome/Android — inert (but harmless) on Safari/iOS, which
  // is this booth's actual target; kept for when this ever runs elsewhere.
  const constraintOptions = [
    {
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 2160 },
        height: { ideal: 3840 },
        focusMode: { ideal: 'continuous' },
        exposureMode: { ideal: 'continuous' },
        whiteBalanceMode: { ideal: 'continuous' },
      },
      audio: false,
    },
    { video: { facingMode: { ideal: 'user' } }, audio: false },
    { video: true, audio: false },
  ];

  let stream = null;
  let lastErr = null;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    lastErr = { name: 'NotSupportedError', message: 'getUserMedia not available' };
  } else {
    for (const constraints of constraintOptions) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastErr = err;
        // Permission denied — no point trying looser constraints
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') break;
        console.warn(`Camera attempt failed (${err.name}), trying looser constraints…`);
      }
    }
  }

  if (stream) {
    state.cameraStream = stream;
    cameraVideo.srcObject = stream;
    await cameraVideo.play();
    cameraHint.textContent = 'Smile! Photo taken automatically';
    startCameraCountdown();
  } else {
    cameraError.hidden = false;
    if (lastErr.name === 'NotAllowedError' || lastErr.name === 'PermissionDeniedError') {
      cameraErrorText.textContent = 'Camera access denied. Please allow camera access in your browser settings.';
    } else if (lastErr.name === 'NotFoundError' || lastErr.name === 'DevicesNotFoundError') {
      cameraErrorText.textContent = 'No camera found on this device.';
    } else if (lastErr.name === 'NotReadableError' || lastErr.name === 'TrackStartError') {
      cameraErrorText.textContent = 'Camera is in use by another app. Close it and try again.';
    } else if (lastErr.name === 'NotSupportedError') {
      cameraErrorText.textContent = 'Camera not supported on this browser. Try Chrome or Safari over HTTPS.';
    } else {
      cameraErrorText.textContent = `Camera error (${lastErr.name || 'unknown'}). Please try again.`;
    }
    console.error('Camera failed after all attempts:', lastErr);
  }
}

function stopCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(t => t.stop());
    state.cameraStream = null;
    cameraVideo.srcObject = null;
  }
  stopCameraCountdown();
}

const CAMERA_COUNTDOWN_SECONDS = 15;

function startCameraCountdown() {
  stopCameraCountdown(); // clear any previous
  let remaining = CAMERA_COUNTDOWN_SECONDS;

  cameraCountdown.hidden = false;
  cameraCountdown.textContent = String(remaining);
  // Force re-trigger animation on first display
  cameraCountdown.style.animation = 'none';
  cameraCountdown.getBoundingClientRect();
  cameraCountdown.style.animation = '';

  state.cameraCountdownInterval = setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      stopCameraCountdown();
      capturePhoto(); // auto-capture
      return;
    }

    cameraCountdown.textContent = String(remaining);
    // Re-trigger pulse animation on each tick
    cameraCountdown.style.animation = 'none';
    cameraCountdown.getBoundingClientRect();
    cameraCountdown.style.animation = '';
  }, 1000);
}

function stopCameraCountdown() {
  clearInterval(state.cameraCountdownInterval);
  state.cameraCountdownInterval = null;
  cameraCountdown.hidden = true;
  cameraCountdown.textContent = '';
}

btnCameraBack.addEventListener('click', () => {
  stopCamera(); // also calls stopCameraCountdown
  showScreen('form');
});

btnCapture.addEventListener('click', () => {
  if (!cameraVideo.srcObject) return;
  stopCameraCountdown(); // cancel auto-capture; user is taking it manually
  capturePhoto();
});

function capturePhoto() {
  const video = cameraVideo;
  const w = video.videoWidth  || 1080;
  const h = video.videoHeight || 1920;

  captureCanvas.width  = w;
  captureCanvas.height = h;

  const ctx = captureCanvas.getContext('2d');
  // Mirror to match what the user sees on screen
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, w, h);

  state.photoDataUrl = captureCanvas.toDataURL('image/jpeg', 0.95);
  previewImg.src = state.photoDataUrl;

  stopCamera();
  showScreen('preview');
}

/* ════════════════════════════════════════════════════════════════════════════
   SCREEN 3 — PREVIEW
════════════════════════════════════════════════════════════════════════════ */
btnRetake.addEventListener('click', () => {
  startCamera();
});

btnSubmit.addEventListener('click', async () => {
  setSubmitLoading(true);
  await submitToSupabase();
});

function setSubmitLoading(loading) {
  btnSubmit.disabled  = loading;
  btnRetake.disabled  = loading;
  submitLabel.textContent = loading ? 'Uploading…' : 'Submit';
  submitSpinner.hidden = !loading;
  submitIcon.hidden    = loading;
}

/* ════════════════════════════════════════════════════════════════════════════
   SUPABASE SUBMISSION
════════════════════════════════════════════════════════════════════════════ */

/** Simple delay helper */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Convert a data-URI string to a Blob for binary upload */
function dataURItoBlob(dataURI) {
  const [header, data] = dataURI.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(data);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/**
 * Step 1: Upload photo blob to Supabase Storage.
 * Returns the public URL of the uploaded file, or throws on failure.
 * Retries up to maxAttempts times with 1.5s delay between attempts.
 */
async function uploadPhotoToStorage(maxAttempts = 3) {
  const filename = `booth-${Date.now()}.jpg`;
  const uploadUrl = `${CONFIG.SUPABASE_URL}/storage/v1/object/booth-photos/${filename}`;
  const publicUrl = `${CONFIG.SUPABASE_URL}/storage/v1/object/public/booth-photos/${filename}`;
  const blob = dataURItoBlob(state.photoDataUrl);

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
          'Content-Type': 'image/jpeg',
        },
        body: blob,
      });

      if (res.ok) return publicUrl;

      const body = await res.json().catch(() => ({}));
      lastError = new Error(`Storage upload failed (${res.status}): ${body.error || body.message || res.statusText}`);
      console.warn(`Photo upload attempt ${attempt}/${maxAttempts} failed:`, lastError.message);
    } catch (err) {
      lastError = err;
      console.warn(`Photo upload attempt ${attempt}/${maxAttempts} error:`, err);
    }

    if (attempt < maxAttempts) await delay(1500);
  }

  throw lastError;
}

/**
 * Step 2: Insert a row into booth_submissions.
 * Retries up to maxAttempts times with 1.5s delay between attempts.
 */
async function insertBoothRecord(photoUrl, maxAttempts = 3) {
  const insertUrl = `${CONFIG.SUPABASE_URL}/rest/v1/booth_submissions`;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(insertUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
          'apikey':         CONFIG.SUPABASE_ANON_KEY,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({
          name:      state.name,
          email:     state.email,
          phone:     state.phone,
          photo_url: photoUrl || null,
        }),
      });

      if (res.ok) return;

      const body = await res.json().catch(() => ({}));
      lastError = new Error(`DB insert failed (${res.status}): ${body.message || res.statusText}`);
      console.warn(`DB insert attempt ${attempt}/${maxAttempts} failed:`, lastError.message);
    } catch (err) {
      lastError = err;
      console.warn(`DB insert attempt ${attempt}/${maxAttempts} error:`, err);
    }

    if (attempt < maxAttempts) await delay(1500);
  }

  throw lastError;
}

/**
 * Emails the captured photo to the guest via lit-dash's existing send-email
 * edge function (SendGrid "custom" type). Fire-and-forget: never blocks or
 * fails the booth submission flow — logs a warning on failure only.
 */
async function sendBoothPhotoEmail(name, email, photoUrl) {
  if (!photoUrl) return; // nothing to send if the photo never made it to Storage

  const content =
    `Hey,\n\n` +
    `Your old profile picture had a good run.\n` +
    `<strong>We've attached its replacement.</strong>\n\n` +
    `<img src="${photoUrl}" alt="Your new LinkedIn headshot" style="max-width:480px;width:100%;border-radius:12px;margin:8px 0 20px;display:block;" />\n\n` +
    `<strong style="font-size:1.05em;">Go make the switch.</strong>\n\n` +
    `<a href="${photoUrl}" style="color:#888;font-size:0.85em;">Or open your photo directly</a>`;

  try {
    const res = await fetch(`${CONFIG.LITDASH_SUPABASE_URL}/functions/v1/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${CONFIG.LITDASH_ANON_KEY}`,
      },
      body: JSON.stringify({
        type:      'custom',
        recipient: { email, name },
        subject:   'Main character energy has been delivered.',
        content,
      }),
    });
    if (!res.ok) {
      console.warn('Booth photo email failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    console.warn('Booth photo email error:', err);
  }
}

/* ── Pending-upload queue (localStorage) ─────────────────────────────────── */
// Two shapes depending on where the failure happened:
//   storageSuccess: false → { base64, name, email, phone, queuedAt }
//   storageSuccess: true  → { photoUrl, name, email, phone, queuedAt }

function queuePendingUpload({ storageSuccess, photoUrl }) {
  try {
    const pending = getPendingUploads();
    const item = {
      storageSuccess,
      name:      state.name,
      email:     state.email,
      phone:     state.phone,
      queuedAt:  new Date().toISOString(),
    };
    if (storageSuccess) {
      item.photoUrl = photoUrl;
    } else {
      item.base64 = state.photoDataUrl.split(',')[1];
    }
    pending.push(item);
    localStorage.setItem('pendingUploads', JSON.stringify(pending));
  } catch (err) {
    console.error('Could not queue pending upload:', err);
  }
}

function getPendingUploads() {
  try {
    return JSON.parse(localStorage.getItem('pendingUploads') || '[]');
  } catch {
    return [];
  }
}

/**
 * Retry any uploads that failed in a previous session.
 * Called on app load AND on every resetApp() — covers the "last person of
 * the event" case where no new sessions follow the failure.
 */
async function retryPendingUploads() {
  const pending = getPendingUploads();
  if (pending.length === 0) return;

  const remaining = [];
  for (const item of pending) {
    try {
      let photoUrl = item.photoUrl || null;

      // If storage failed previously, re-upload the photo first
      if (!item.storageSuccess && item.base64) {
        const filename = `booth-retry-${Date.now()}.jpg`;
        const uploadUrl = `${CONFIG.SUPABASE_URL}/storage/v1/object/booth-photos/${filename}`;
        const binary = atob(item.base64);
        const arr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
        const blob = new Blob([arr], { type: 'image/jpeg' });

        const storageRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
            'Content-Type':  'image/jpeg',
          },
          body: blob,
        });

        if (storageRes.ok) {
          photoUrl = `${CONFIG.SUPABASE_URL}/storage/v1/object/public/booth-photos/${filename}`;
        } else {
          console.warn(`Retry storage upload failed for queued item, keeping in queue`);
          remaining.push(item);
          continue;
        }
      }

      // Insert the DB record
      const insertRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/booth_submissions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
          'apikey':         CONFIG.SUPABASE_ANON_KEY,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({
          name:      item.name,
          email:     item.email,
          phone:     item.phone,
          photo_url: photoUrl,
        }),
      });

      if (insertRes.ok) {
        console.log(`Retried pending submission for ${item.email} — success`);
        sendBoothPhotoEmail(item.name, item.email, photoUrl).catch(() => {});
      } else {
        console.warn(`Retry DB insert failed for ${item.email}, keeping in queue`);
        remaining.push({ ...item, storageSuccess: true, photoUrl, base64: undefined });
      }
    } catch (err) {
      console.warn(`Retry error for ${item.email}:`, err);
      remaining.push(item);
    }
  }

  if (remaining.length !== pending.length) {
    localStorage.setItem('pendingUploads', JSON.stringify(remaining));
  }
}

/**
 * Orchestrates the full 2-step submission: upload photo → insert row.
 */
async function submitToSupabase() {
  // Fire-and-forget retry of any previous failures
  retryPendingUploads().catch(() => {});

  // Step 1: upload photo to Storage
  let photoUrl = null;
  try {
    photoUrl = await uploadPhotoToStorage();
  } catch (err) {
    console.error('Photo storage upload failed after all retries:', err);
    queuePendingUpload({ storageSuccess: false });
    setSubmitLoading(false);
    showScreen('thankyou');
    startThankYouCountdown();
    setTimeout(() => {
      showToast('Details saved! Photo will retry on next startup.', 'warning', 6000);
    }, 800);
    return;
  }

  // Step 2: insert row into booth_submissions
  try {
    await insertBoothRecord(photoUrl);
    sendBoothPhotoEmail(state.name, state.email, photoUrl).catch(() => {});
  } catch (err) {
    console.error('DB insert failed after all retries:', err);
    queuePendingUpload({ storageSuccess: true, photoUrl });
    setSubmitLoading(false);
    showScreen('thankyou');
    startThankYouCountdown();
    setTimeout(() => {
      showToast('Photo saved! Details will sync on next startup.', 'warning', 6000);
    }, 800);
    return;
  }

  setSubmitLoading(false);
  showScreen('thankyou');
  startThankYouCountdown();
}

/* ════════════════════════════════════════════════════════════════════════════
   SCREEN 4 — THANK YOU + COUNTDOWN
════════════════════════════════════════════════════════════════════════════ */
const COUNTDOWN_SECONDS = 5;
// Circumference = 2π × r = 2π × 26 ≈ 163.36
const RING_CIRCUMFERENCE = 2 * Math.PI * 26;

function startThankYouCountdown() {
  const firstName = state.name.split(' ')[0] || 'there';
  thankyouName.textContent = firstName;

  let remaining = COUNTDOWN_SECONDS;

  // Reset ring to full
  countdownArc.style.transition = 'none';
  countdownArc.style.strokeDashoffset = '0';
  countdownNumber.textContent = String(remaining);

  // Force reflow before starting transition
  countdownArc.getBoundingClientRect();
  countdownArc.style.transition = 'stroke-dashoffset 1s linear';

  clearInterval(state.countdownInterval);
  clearTimeout(state.countdownTimer);

  state.countdownInterval = setInterval(() => {
    remaining -= 1;
    countdownNumber.textContent = String(remaining);
    // Advance the arc: offset grows from 0 → full circumference over 5 steps
    const offset = ((COUNTDOWN_SECONDS - remaining) / COUNTDOWN_SECONDS) * RING_CIRCUMFERENCE;
    countdownArc.style.strokeDashoffset = String(offset);

    if (remaining <= 0) {
      clearInterval(state.countdownInterval);
    }
  }, 1000);

  state.countdownTimer = setTimeout(() => {
    resetApp();
  }, COUNTDOWN_SECONDS * 1000 + 100); // +100ms buffer after last tick
}

/* ════════════════════════════════════════════════════════════════════════════
   RESET
════════════════════════════════════════════════════════════════════════════ */
function resetApp() {
  // Stop any running timers
  clearInterval(state.countdownInterval);
  clearTimeout(state.countdownTimer);

  // Stop camera if somehow still running
  stopCamera();

  // Clear form
  fieldName.value  = '';
  fieldEmail.value = '';
  fieldPhone.value = '';
  [fieldName, fieldEmail, fieldPhone].forEach(el => el.classList.remove('error', 'valid'));
  [errorName, errorEmail, errorPhone].forEach(el => el.textContent = '');
  btnContinue.disabled = true;
  btnContinue.setAttribute('aria-disabled', 'true');

  // Clear photo state
  state.photoDataUrl = null;
  previewImg.src = '';

  // Reset submit button
  setSubmitLoading(false);

  // Reset countdown ring
  countdownArc.style.transition = 'none';
  countdownArc.style.strokeDashoffset = '0';

  // Retry any pending photo uploads (covers "last person of event" case)
  retryPendingUploads().catch(() => {});

  // Navigate back to form
  // Direct swap without transition to ensure clean reset
  Object.values(screens).forEach(s => {
    s.classList.remove('active', 'exit');
  });
  screens.form.classList.add('active');
  currentScreen = 'form';
}

/* ── Admin gesture — 5 taps in top-right corner exits fullscreen / kiosk ─── */
(function () {
  const zone = document.getElementById('admin-tap-zone');
  if (!zone) return;

  const REQUIRED_TAPS = 5;
  const TAP_WINDOW_MS = 3000; // taps must happen within 3 seconds

  let tapCount = 0;
  let tapTimer = null;

  zone.addEventListener('click', () => {
    tapCount += 1;

    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { tapCount = 0; }, TAP_WINDOW_MS);

    if (tapCount >= REQUIRED_TAPS) {
      tapCount = 0;
      clearTimeout(tapTimer);

      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitFullscreenElement) {
        document.webkitExitFullscreen();
      } else {
        // Not in fullscreen — prompt staff with a quick confirm to reload/home
        const leave = confirm('Staff: exit kiosk mode?');
        if (leave) window.location.href = 'about:blank';
      }
    }
  });
})();

/* ── Physical orientation lock (drives #rotate-prompt) ──────────────────── */
// Uses screen.width/height — the physical screen resolution — instead of a
// CSS `orientation` media query or window.innerWidth/innerHeight. Those are
// viewport-based and misfire when the on-screen keyboard shrinks the layout
// viewport enough to flip width>height mid-typing, hiding .screen and
// blurring the focused input (which closes the keyboard). screen.width/
// height reflect the device's physical screen in its current orientation
// and never change when the keyboard opens; they've been reliably supported
// across mobile browsers (including Safari) for far longer than the newer
// screen.orientation API.
(function () {
  function isPhysicallyLandscape() {
    return screen.width > screen.height;
  }

  function updateOrientationClass() {
    document.documentElement.classList.toggle('is-landscape', isPhysicallyLandscape());
  }

  window.addEventListener('orientationchange', updateOrientationClass);
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', updateOrientationClass);
  }
  updateOrientationClass();
})();

/* ── Boot ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Retry any uploads that failed in a previous session
  retryPendingUploads().catch(() => {});

  // Ensure form screen is active on load
  screens.form.classList.add('active');
});

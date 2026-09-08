// Step 5 (Q4 graded work samples): per-tier photo picking/thumbnails, written
// (text) artifact editors, and the per-tier persistence used by saveProfile.

import { T } from './state.js';
import { showToast } from './ui.js';
import { upsertWorkArtifact, deleteWorkArtifact } from './profileApi.js';
import {
  TEXT_ARTIFACT_TYPES, MAX_ARTIFACT_TEXT, MAX_TEXT_ARTIFACTS_PER_TIER, MAX_PHOTOS_PER_TIER,
  remainingPhotoSlots, isHeicFile, isSupportedImageType,
} from './wizardState.js';

// ─── PHOTOS ──────────────────────────────────────────────────────────────────
export async function handleSampleFiles(tier, event) {
  const files = Array.from(event.target.files || []);
  event.target.value = ''; // allow re-picking the same file later
  if (!files.length) return;

  const slot = T.workSamples[tier];
  let remaining = remainingPhotoSlots(slot);
  if (remaining <= 0) {
    showToast(`Already have ${MAX_PHOTOS_PER_TIER}/${MAX_PHOTOS_PER_TIER} photos for ${tier}.`, 'error');
    return;
  }

  const conv = document.getElementById('tierConverting-' + tier);
  for (const file of files) {
    if (remaining <= 0) {
      showToast(`Cap of ${MAX_PHOTOS_PER_TIER} photos reached for ${tier}; remaining files skipped.`, 'error');
      break;
    }
    let f = file;
    if (isHeicFile(file)) {
      if (typeof heic2any !== 'function') {
        showToast('HEIC support is still loading — please try again in a moment.', 'error');
        continue;
      }
      conv.classList.add('active');
      try {
        const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
        const out = Array.isArray(blob) ? blob[0] : blob;
        f = new File([out], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
      } catch (err) {
        console.warn('HEIC conversion failed:', err);
        showToast('Could not convert HEIC photo — please try a JPEG/PNG.', 'error');
        conv.classList.remove('active');
        continue;
      }
      conv.classList.remove('active');
    }
    if (!isSupportedImageType(f.type)) {
      showToast(`Skipped ${f.name}: only JPEG/PNG/WebP are supported.`, 'error');
      continue;
    }
    slot.photos.push(f);
    remaining--;
  }
  renderTierUI(tier);
  validateStep4();
}

export function removeSamplePhoto(tier, kind, idx) {
  const slot = T.workSamples[tier];
  if (kind === 'new') {
    slot.photos.splice(idx, 1);
  } else if (kind === 'existing') {
    slot.existingPaths.splice(idx, 1);
    if (slot.existingThumbUrls) slot.existingThumbUrls.splice(idx, 1);
  }
  renderTierUI(tier);
  validateStep4();
}

export function renderTierUI(tier) {
  const container = document.getElementById('tierThumbs-' + tier);
  if (!container) return;
  const slot = T.workSamples[tier];
  container.innerHTML = '';
  (slot.existingPaths || []).forEach((path, i) => {
    const url = (slot.existingThumbUrls && slot.existingThumbUrls[i]) || '';
    container.appendChild(makeThumb(url, () => removeSamplePhoto(tier, 'existing', i)));
  });
  slot.photos.forEach((file, i) => {
    const url = URL.createObjectURL(file);
    container.appendChild(makeThumb(url, () => removeSamplePhoto(tier, 'new', i)));
  });
  const total = slot.existingPaths.length + slot.photos.length;
  const countEl = document.getElementById('tierCount-' + tier);
  if (countEl) countEl.textContent = total > 0 ? `(${total}/${MAX_PHOTOS_PER_TIER})` : '(optional)';
  const addBtn = document.getElementById('tierAddBtn-' + tier);
  if (addBtn) addBtn.disabled = total >= MAX_PHOTOS_PER_TIER;
}

function makeThumb(url, onRemove) {
  const div = document.createElement('div');
  div.className = 'tier-thumb';
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    div.appendChild(img);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'tier-thumb-x';
  x.setAttribute('aria-label', 'Remove photo');
  x.textContent = '×';
  x.addEventListener('click', onRemove);
  div.appendChild(x);
  return div;
}

// ─── WRITTEN-EXAMPLE (TEXT) ARTIFACTS (Q4 v2) ────────────────────────────────
export function addTextArtifact(tier) {
  // Cap client-side so a teacher can't build an unsaveable tier: the Lambda 409s
  // the 6th create, which would fail the whole tier save with no visible reason.
  if (T.workSamples[tier].textArtifacts.length >= MAX_TEXT_ARTIFACTS_PER_TIER) {
    showToast(`Up to ${MAX_TEXT_ARTIFACTS_PER_TIER} written examples per level.`, 'error');
    return;
  }
  T.workSamples[tier].textArtifacts.push({ id: null, type: 'comment', text: '', label: '' });
  renderTierArtifacts(tier);
  validateStep4();
  const container = document.getElementById('tierArtifacts-' + tier);
  const ta = container && container.lastElementChild && container.lastElementChild.querySelector('.tier-artifact-text');
  if (ta) ta.focus();
}

export function removeTextArtifact(tier, idx) {
  T.workSamples[tier].textArtifacts.splice(idx, 1);
  renderTierArtifacts(tier);
  validateStep4();
}

// Rebuild the written-example editor list for one tier. Handlers mutate the
// backing artifact object in place (closure), so keystrokes don't re-render and
// never steal focus; only add/remove rebuild the list.
export function renderTierArtifacts(tier) {
  const container = document.getElementById('tierArtifacts-' + tier);
  if (!container) return;
  container.innerHTML = '';
  T.workSamples[tier].textArtifacts.forEach((art, idx) => {
    const card = document.createElement('div');
    card.className = 'tier-artifact';

    const row = document.createElement('div');
    row.className = 'tier-artifact-row';

    const sel = document.createElement('select');
    sel.className = 'tier-artifact-type';
    sel.setAttribute('aria-label', 'Example type');
    TEXT_ARTIFACT_TYPES.forEach(t => {
      const o = document.createElement('option');
      o.value = t.value; o.textContent = t.label;
      if (t.value === art.type) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => { art.type = sel.value; });

    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'tier-artifact-label';
    label.placeholder = "Optional label (e.g. 'Q2 report comment')";
    label.maxLength = 200;
    label.value = art.label || '';
    label.addEventListener('input', () => { art.label = label.value; });

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'tier-artifact-remove';
    rm.setAttribute('aria-label', 'Remove written example');
    rm.textContent = '×';
    rm.addEventListener('click', () => removeTextArtifact(tier, idx));

    row.append(sel, label, rm);

    const ta = document.createElement('textarea');
    ta.className = 'tier-artifact-text';
    ta.setAttribute('aria-label', 'Written example text');
    ta.placeholder = 'Paste or type a real example — a comment you’d write, a few lines of feedback, or what you’d say out loud. The more specific, the better Lumi matches your voice.';
    ta.maxLength = MAX_ARTIFACT_TEXT;
    ta.value = art.text || '';

    const count = document.createElement('div');
    count.className = 'tier-artifact-count';
    const updateCount = () => {
      const n = ta.value.length;
      count.textContent = `${n}/${MAX_ARTIFACT_TEXT}`;
      count.classList.toggle('over', n >= MAX_ARTIFACT_TEXT);
    };
    ta.addEventListener('input', () => { art.text = ta.value; updateCount(); validateStep4(); });
    updateCount();

    card.append(row, ta, count);
    container.appendChild(card);
  });
}

// Persist one tier's written-example artifacts to teacher_work_artifacts.
// New/edited editors with non-empty text → POST (upsert by id when present).
// Existing artifacts whose editor was removed OR emptied → soft-DELETE. Saved
// ids are captured back onto the editor so a per-tier retry upserts, never dupes.
export async function saveTierArtifacts(tier, profileId, local) {
  const editors = local.textArtifacts || [];
  const survivingIds = new Set();
  for (let idx = 0; idx < editors.length; idx++) {
    const art = editors[idx];
    const text = (art.text || '').trim();
    // Blank editor is not written. An emptied EXISTING artifact keeps its id out
    // of survivingIds, so it falls into the removed set below (empty = remove) and
    // gets soft-deleted; null its id here so if the teacher retypes into the same
    // card and saves again, it INSERTs fresh instead of upserting a now-soft-
    // deleted row (which the Lambda's `deleted_at IS NULL` guard would 404).
    if (!text) { art.id = null; continue; }
    const body = {
      teacher_profile_id: profileId,
      tier,
      artifact_type: art.type || 'comment',
      text_content: art.text,
      label: (art.label || '').trim() || null,
      sort_order: idx, // preserve the teacher's on-screen order deterministically
    };
    if (art.id) body.id = art.id;
    const saved = await upsertWorkArtifact(body);
    if (saved && saved.id) art.id = saved.id; // capture id from a new INSERT → retry upserts
    if (art.id) survivingIds.add(art.id);
  }
  // Soft-delete existing artifacts the teacher removed or emptied this session.
  const removed = (T.existingArtifactsByTier[tier] || []).filter(a => a.id && !survivingIds.has(a.id));
  for (const r of removed) {
    await deleteWorkArtifact(r.id);
  }
  // Refresh in-session snapshots so a re-open / retry reflects the saved state.
  T.existingArtifactsByTier[tier] = [...survivingIds].map(id => ({ id }));
  (T.artifactsByProfile[profileId] ||= {})[tier] = editors
    .filter(a => (a.text || '').trim() && a.id)
    .map(a => ({ id: a.id, teacher_profile_id: profileId, tier, artifact_type: a.type, text_content: a.text, label: (a.label || '').trim() || null }));
}

export function validateStep4() {
  // Step 5 (work samples) is fully optional — photos, written examples, and the
  // per-tier description can all be skipped. Continue is never gated (D6-A-i).
  document.querySelectorAll('.tier-card').forEach(c => c.classList.remove('invalid'));
  const btn = document.getElementById('step5NextBtn');
  if (btn) btn.disabled = false;
  return true;
}

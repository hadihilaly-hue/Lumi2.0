// Step 3 multi-syllabus upload: pdf.js text extraction, drag-and-drop, and the
// file list. `pdfjsLib` is the classic-script global loaded by teacher.html.

import { T } from './state.js';
import { showToast } from './ui.js';
import {
  SYLLABUS_MAX_FILES, SYLLABUS_MAX_SIZE_BYTES, countWords, formatFileSize, baseName,
} from './wizardState.js';

export async function extractPdfText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text.trim();
}

export async function handleSyllabusUpload(event) {
  const files = Array.from(event.target.files);
  // Reset the input first so the same file can be re-selected later if needed.
  event.target.value = '';
  if (!files.length) return;
  if (T.syllabusProcessing) {
    showToast('Still reading the previous selection — try again in a moment.', 'error');
    return;
  }
  T.syllabusProcessing = true;

  let added = 0;
  let firstNewExtractedText = '';

  for (const file of files) {
    const totalNow = T.syllabusExistingPaths.length + T.syllabusNewFiles.length;
    if (totalNow >= SYLLABUS_MAX_FILES) {
      showToast(`Cap of ${SYLLABUS_MAX_FILES} syllabi reached; remaining files skipped.`, 'error');
      break;
    }
    if (file.type !== 'application/pdf') {
      showToast(`Skipped ${file.name}: only PDFs are supported.`, 'error');
      continue;
    }
    if (file.size > SYLLABUS_MAX_SIZE_BYTES) {
      showToast(`Skipped ${file.name}: file exceeds 10MB.`, 'error');
      continue;
    }

    let extractedText = '';
    setSyllabusBusy(`Reading ${file.name}…`);
    try {
      const arrayBuffer = await file.arrayBuffer();
      extractedText = await extractPdfText(arrayBuffer);
    } catch (err) {
      console.error('PDF extraction error for', file.name, err);
      // Still add the file — the blob uploads and is stored, the AI just
      // won't see this PDF's text. Toast is informational, not blocking.
      showToast(`Couldn't extract text from ${file.name}; the file will still be uploaded.`, 'error');
    }

    T.syllabusNewFiles.push({ file, extractedText });
    if (!firstNewExtractedText && extractedText) firstNewExtractedText = extractedText;
    added++;
  }

  // Auto-fill course info from the first newly-extracted text IF the field
  // is still mostly empty. Mirrors the original single-file behavior — a
  // help-not-clobber gesture for teachers who haven't typed much yet.
  if (firstNewExtractedText) {
    const courseInput = document.getElementById('courseInfoInput');
    if (countWords(courseInput.value) < 20) {
      courseInput.value = (courseInput.value ? courseInput.value + '\n\n' : '') +
        '--- Extracted from syllabus ---\n' + firstNewExtractedText.substring(0, 2000);
      courseInput.dispatchEvent(new Event('input'));
    }
  }

  setSyllabusBusy(null);
  T.syllabusProcessing = false;
  if (added > 0) {
    showToast(`Added ${added} ${added === 1 ? 'syllabus' : 'syllabi'}.`, 'success');
  }
  renderSyllabusList();
}

// Swaps the dropzone hint for a progress line while pdf.js reads a file;
// pass null to restore the default hint.
export function setSyllabusBusy(message) {
  const area = document.getElementById('syllabusUploadArea');
  const hint = document.getElementById('syllabusUploadHint');
  if (!area || !hint) return;
  if (T.syllabusDefaultHint == null) T.syllabusDefaultHint = hint.textContent;
  area.classList.toggle('busy', !!message);
  area.setAttribute('aria-busy', message ? 'true' : 'false');
  hint.textContent = message || T.syllabusDefaultHint;
}

// Drag-and-drop handlers — funnel into handleSyllabusUpload via a synthesized
// file-input event so the validation/extraction pipeline is identical to the
// click-to-pick path.
export function handleSyllabusDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add('dragover');
}

export function handleSyllabusDragLeave(event) {
  // Ignore leave events fired when the cursor moves onto a child element —
  // the dropzone has decorative children (icon, text, hint) and a naive
  // remove() flickers in that case.
  const area = event.currentTarget;
  if (event.relatedTarget && area.contains(event.relatedTarget)) return;
  area.classList.remove('dragover');
}

export function handleSyllabusDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('dragover');
  handleSyllabusUpload({ target: { files: event.dataTransfer.files } });
}

export function renderSyllabusList() {
  const list = document.getElementById('syllabusFileList');
  if (!list) return;
  list.innerHTML = '';

  // Existing-path rows (already in storage). × removes from
  // T.syllabusExistingPaths; the file gets deleted from the bucket on save.
  T.syllabusExistingPaths.forEach((path, i) => {
    list.appendChild(makeSyllabusRow({
      filename: baseName(path),
      pending: false,
      onRemove: () => {
        T.syllabusExistingPaths.splice(i, 1);
        renderSyllabusList();
      },
    }));
  });

  // New-file rows (in memory only). × removes from T.syllabusNewFiles;
  // no storage write to undo since they were never uploaded.
  T.syllabusNewFiles.forEach((entry, i) => {
    list.appendChild(makeSyllabusRow({
      filename: entry.file.name,
      sizeBytes: entry.file.size,
      pending: true,
      onRemove: () => {
        T.syllabusNewFiles.splice(i, 1);
        renderSyllabusList();
      },
    }));
  });

  const total = T.syllabusExistingPaths.length + T.syllabusNewFiles.length;
  const countEl = document.getElementById('syllabusCount');
  if (countEl) countEl.textContent = `(${total}/${SYLLABUS_MAX_FILES})`;
  const area = document.getElementById('syllabusUploadArea');
  if (area) area.classList.toggle('full', total >= SYLLABUS_MAX_FILES);
}

function makeSyllabusRow({ filename, sizeBytes, pending, onRemove }) {
  const row = document.createElement('div');
  row.className = 'syllabus-file-row' + (pending ? ' pending' : '');
  const icon = document.createElement('span');
  icon.className = 'syllabus-file-icon';
  icon.textContent = '';
  row.appendChild(icon);
  const name = document.createElement('div');
  name.className = 'syllabus-file-name-cell';
  name.textContent = filename;
  row.appendChild(name);
  if (sizeBytes != null) {
    const size = document.createElement('span');
    size.className = 'syllabus-file-size';
    size.textContent = formatFileSize(sizeBytes);
    row.appendChild(size);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'syllabus-file-x';
  x.setAttribute('aria-label', 'Remove syllabus');
  x.textContent = '×';
  x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
  row.appendChild(x);
  return row;
}

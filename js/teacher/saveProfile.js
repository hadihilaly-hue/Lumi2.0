// Step 6 "Save and Finish": syllabus upload + reconciliation, the
// teacher_profiles upsert, then per-tier work-sample persistence.

import { TIERS } from './config.js';
import { T } from './state.js';
import { showToast } from './ui.js';
import {
  upsertProfile, upsertWorkSample, uploadViaSignedUrl, fetchDownloadUrl, generateSuggestedPrompts,
} from './profileApi.js';
import {
  SYLLABUS_TEXT_CAP, classSlug, cleanFileName, combineSyllabusText, firstInvalidStep, tierHasSampleContent,
} from './wizardState.js';
import { extractPdfText } from './syllabus.js';
import { saveTierArtifacts } from './workSamples.js';
import { goHome, showStep } from './wizardUi.js';

export async function saveTeacherProfile() {
  if (T.saving) return;

  const title = document.getElementById('titleSelect').value || null;
  const engagementRules = document.getElementById('engagementRulesInput').value.trim();
  const teachingVoice = document.getElementById('teachingVoiceInput').value.trim();
  const courseInfo = document.getElementById('courseInfoInput').value.trim();
  const welcomeMessage = document.getElementById('welcomeMessageInput').value.trim();
  const shareCourseInfo = document.getElementById('shareCourseInfoCheckbox').checked;

  const invalidStep = firstInvalidStep({ title, engagementRules, teachingVoice, courseInfo, welcomeMessage });
  if (invalidStep) {
    showToast(`Step ${invalidStep} still needs a bit more before saving.`, 'error');
    showStep(invalidStep);
    return;
  }

  T.saving = true;
  const btn = document.getElementById('saveProfileBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    // ─── MULTI-SYLLABUS UPLOAD + RECONCILIATION ──────────────────────────────
    // Strategy: upload all newly-picked PDFs to storage in parallel, compute
    // the final syllabus_paths array (existing-kept ∪ new-uploaded), delete
    // any removed paths from storage, and produce the combined syllabus_text
    // capped at SYLLABUS_TEXT_CAP for safe injection into the student system
    // prompt. Existing-paths text is reused from the previously-stored
    // syllabus_text blob when the set hasn't changed (fast path); otherwise
    // we re-download and re-extract surviving paths so removals don't leave
    // stale text behind.
    const course = T.currentClass.course;
    const oldPaths = Array.isArray(T.profiles[course]?.syllabus_paths)
      ? [...T.profiles[course].syllabus_paths]
      : [];

    let newlyUploadedPaths = [];
    if (T.syllabusNewFiles.length) {
      const slug = classSlug(course);
      newlyUploadedPaths = await Promise.all(
        T.syllabusNewFiles.map(({ file }) => uploadViaSignedUrl({
          bucket: 'syllabi',
          filename: cleanFileName(file.name),
          contentType: 'application/pdf',
          classId: slug,
        }, file))
      );
    }

    const combinedPaths = [...T.syllabusExistingPaths, ...newlyUploadedPaths];

    // TODO(Week2+): Lambda has no /delete-objects endpoint yet. Files removed from a
    // teacher's list become S3 orphans. Acceptable for demo (cents/month at our scale).
    // Fix options when prioritized: (a) add /delete-objects to Lambda, or (b) add an
    // S3 lifecycle rule to auto-expire unreferenced objects.
    const toDelete = oldPaths.filter(p => !combinedPaths.includes(p));
    if (toDelete.length) {
      console.info('[syllabi] skipped delete (S3 migration pending /delete-objects):', toDelete);
    }

    const existingUnchanged =
      T.syllabusExistingPaths.length === oldPaths.length &&
      T.syllabusExistingPaths.every(p => oldPaths.includes(p));

    let existingText = '';
    if (existingUnchanged) {
      // Fast path: previously-stored syllabus_text already represents the
      // unchanged surviving paths. No need to re-download anything.
      existingText = T.profiles[course]?.syllabus_text || '';
    } else if (T.syllabusExistingPaths.length) {
      // Set changed: re-extract every surviving existing path so removed-file
      // text doesn't linger. Failures per file are tolerated — the file stays
      // in storage but its text is dropped from this save's combined blob.
      const texts = await Promise.all(T.syllabusExistingPaths.map(async (path) => {
        try {
          const downloadUrl = await fetchDownloadUrl('syllabi', path);
          if (!downloadUrl) return '';
          const fileRes = await fetch(downloadUrl);
          if (!fileRes.ok) return '';
          const arrayBuffer = await fileRes.arrayBuffer();
          return await extractPdfText(arrayBuffer);
        } catch (err) {
          console.warn('[syllabi] re-extract failed for', path, err);
          return '';
        }
      }));
      existingText = texts.filter(Boolean).join('\n\n');
    }

    const { text: combinedText, truncated } = combineSyllabusText(existingText, T.syllabusNewFiles);
    if (truncated) {
      showToast(
        `Your combined syllabi exceed ${SYLLABUS_TEXT_CAP / 1000}K characters; only the first portion will be used by the AI.`,
        'error'
      );
    }

    // Save to database. syllabus_paths is the source of truth; the legacy
    // syllabus_file_path receives combinedPaths[0] for backward compat with
    // the column during the transition window — drop in the follow-up
    // cleanup migration once production data has flushed through.
    const profileRow = {
      course_name: course,
      title,
      engagement_rules: engagementRules,
      teaching_voice: teachingVoice,
      course_info: courseInfo,
      welcome_message: welcomeMessage || null,
      syllabus_paths: combinedPaths,
      syllabus_file_path: combinedPaths[0] || null,
      syllabus_text: combinedText || null,
      syllabus_uploaded_at: combinedPaths.length ? new Date().toISOString() : null,
      share_course_info: shareCourseInfo,
      done: true,
    };
    const data = await upsertProfile(profileRow);
    if (!data) throw new Error('teacher-profile save returned no row');

    // Q4: upload work-sample photos and upsert teacher_work_samples (one row per tier).
    // Per-tier failures are tolerated — successful tiers are persisted and the
    // failing tier(s) can be retried without re-uploading what's already in.
    const profileId = data.id;
    const failedTiers = [];

    for (const tier of TIERS) {
      const local = T.workSamples[tier];
      try {
        // Q4 v2: only write teacher_work_samples when the tier has photo or
        // description content. A fully-empty tier is skipped (no spurious
        // empty-description 400); a text-only tier persists via saveTierArtifacts.
        if (tierHasSampleContent(local)) {
          if (local.photos.length) {
            const slug = classSlug(course);
            const newPaths = await Promise.all(local.photos.map(file => uploadViaSignedUrl({
              bucket: 'work-samples',
              filename: cleanFileName(file.name),
              contentType: file.type || 'image/jpeg',
              classId: slug,
              tier,
            }, file)));
            // Promote successful uploads into existingPaths so a retry skips them.
            local.existingPaths = [...local.existingPaths, ...newPaths];
            local.photos = [];
          }

          const finalPaths = [...local.existingPaths];

          // Detect deletes: paths from the old DB row not in finalPaths.
          const oldTierPaths = (T.existingSamplesByTier[tier]?.photo_paths) || [];
          const tierToDelete = oldTierPaths.filter(p => !finalPaths.includes(p));
          if (tierToDelete.length) {
            // TODO(Week2+): Lambda has no /delete-objects endpoint yet. Files removed
            // from a tier become S3 orphans. Acceptable for demo (cents/month). Fix
            // options: (a) add /delete-objects to Lambda, or (b) S3 lifecycle rule.
            console.info(`[Q4] skipped delete for ${tier} (S3 migration pending /delete-objects):`, tierToDelete);
          }

          // Throws on non-2xx → caught by the per-tier handler below.
          await upsertWorkSample({
            teacher_profile_id: profileId,
            tier,
            description: local.description.trim(),
            photo_paths: finalPaths,
          });

          // Mirror DB snapshot for next-edit delete-detection.
          T.existingSamplesByTier[tier] = { photo_paths: [...finalPaths] };
          (T.samplesByProfile[profileId] ||= {})[tier] = {
            teacher_profile_id: profileId, tier,
            description: local.description.trim(),
            photo_paths: [...finalPaths],
          };
        }

        // Q4 v2: persist this tier's written-example (text) artifacts.
        await saveTierArtifacts(tier, profileId, local);
      } catch (e) {
        console.warn(`[Q4] tier ${tier} failed:`, e);
        failedTiers.push(tier);
      }
    }

    if (failedTiers.length) {
      showToast(`Saved profile, but ${failedTiers.join(', ')} sample upload failed. Click Save again to retry.`, 'error');
      btn.disabled = false;
      btn.textContent = 'Save and Finish';
      T.profiles[course] = data; // profile itself did save; reflect that
      return;
    }

    T.profiles[course] = data;
    showToast('Profile saved!', 'success');

    // Generate suggested prompts in background (non-blocking)
    generateSuggestedPrompts(courseInfo, combinedText, T.user.email, course);

    T.wizardSnapshot = null;
    goHome({ force: true });

  } catch (err) {
    console.error('Save error:', err);
    showToast('Could not save your class. Nothing was lost — check your connection and click Save and Finish again.', 'error');
  } finally {
    T.saving = false;
    btn.disabled = false;
    btn.textContent = 'Save and Finish';
  }
}

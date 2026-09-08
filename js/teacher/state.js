// Mutable teacher-portal state shared across the js/teacher modules.
//
// One object (like `S` in js/state.js) so every module reads/writes the same
// live fields; callers must not alias sub-objects across an openWizard() reset.

// Q4 work-samples state. Re-initialized in openWizard().
// `photos`        — newly-picked File objects awaiting upload at save time.
// `description`   — textarea contents.
// `existingPaths` — Storage paths of already-uploaded photos kept across an edit.
// `textArtifacts` — Q4 v2 written-example editors: [{ id, type, text, label }]
//                   (id null for a new one; text artifacts persist to the
//                   teacher_work_artifacts table via /work-artifacts).
export function emptyWorkSamples() {
  return {
    progressing: { photos: [], description: '', existingPaths: [], textArtifacts: [] },
    proficient:  { photos: [], description: '', existingPaths: [], textArtifacts: [] },
    exemplary:   { photos: [], description: '', existingPaths: [], textArtifacts: [] },
  };
}

export const T = {
  user: null,
  teacher: null,
  profiles: {},
  currentClass: null,
  currentStep: 1,
  // Multi-syllabus state. Re-initialized in openWizard().
  // `syllabusNewFiles`      — newly-picked PDFs awaiting upload at save time;
  //                            each entry caches its client-side-extracted text.
  // `syllabusExistingPaths` — Storage paths of already-uploaded syllabi kept
  //                            across an edit. × button removes from this array;
  //                            the file gets deleted from storage on save.
  syllabusNewFiles: [],
  syllabusExistingPaths: [],
  syllabusProcessing: false,
  syllabusDefaultHint: '',
  templateData: null,
  recognition: null,
  recordingField: null,
  enrollments: [],
  currentEnrollmentId: null,
  currentRoster: { profileId: null, block: null },
  expandedCourse: null,
  workSamples: emptyWorkSamples(),
  // Per-profile cache of work-samples rows from teacher_work_samples,
  // populated by loadAllTeacherProfiles() (Phase 4). Keyed by
  // teacher_profile_id, then tier. Used to drive the banner and to seed
  // workSamples on edit.
  samplesByProfile: {},
  // Q4 v2: per-profile cache of teacher_work_artifacts rows (owner-scoped GET),
  // keyed by teacher_profile_id then tier → [rows].
  artifactsByProfile: {},
  // Snapshot of the current course's existing samples (set when wizard
  // opens for an edit) so the save handler can detect deleted paths.
  existingSamplesByTier: {},
  // Q4 v2: snapshot of the current course's existing text artifacts per tier
  // (set at wizard open) so the save handler can soft-delete removed ones.
  existingArtifactsByTier: {},
  wizardSnapshot: null,
  saving: false,
};

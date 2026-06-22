import {
  Check,
  Clipboard,
  Download,
  FileCheck2,
  FileJson,
  FolderOpen,
  HelpCircle,
  Plus,
  Trash2,
  Upload
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  ClaudeValidationResult,
  FileMetadata,
  ReviewJobFile,
  ReviewPackageResult,
  ReviewSourceValidation,
  SavedStylePreset,
  StyleConfig
} from "../../shared/types";
import type { UpdateSettings } from "../hooks/useLocalPreferences";
import { ErrorBanner, StatusBanner, LoadingOverlay, PageHeader, DropZone, EmptyDrop, FileCard, FolderField, AdvancedPanel, FieldGroup, SelectField } from "../components/common";
import { userError, type UserFacingError } from "../lib/errors";
import { extension, fileName, labelize, withoutExtension } from "../lib/format";
import {
  additionalReviewPresets,
  cloneStyle,
  commentStyles,
  defaultStyle,
  formatTokens,
  renderPreview,
  reviewTypes,
  styleForChoice,
  type CommentStyleId,
  type ReviewTypeId,
  wordingSignals
} from "./presets";
import {
  approvedFindingInputs,
  defaultDecisions,
  hasPendingDecisions,
  ReviewFindingsPanel,
  type FindingDecision
} from "./ReviewFindings";

export function Commenter({
  settings,
  updateSettings,
  loaded
}: {
  settings: AppSettings;
  updateSettings: UpdateSettings;
  loaded: boolean;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [source, setSource] = useState<FileMetadata | null>(null);
  const [outputFolder, setOutputFolder] = useState("");
  const [reviewType, setReviewType] = useState<ReviewTypeId>("full");
  const [reviewInstructions, setReviewInstructions] = useState(reviewTypes[0].instructions);
  const [commentStyle, setCommentStyle] = useState<CommentStyleId>("hl-concise");
  const [customStyle, setCustomStyle] = useState<StyleConfig>(cloneStyle(defaultStyle));
  const [savedStyles, setSavedStyles] = useState<SavedStylePreset[]>([]);
  const [newStyleName, setNewStyleName] = useState("");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const styleTouchedRef = useRef(false);
  const [showSkillSetup, setShowSkillSetup] = useState(false);
  const [packageResult, setPackageResult] = useState<ReviewPackageResult | null>(null);
  const [resumeJob, setResumeJob] = useState<ReviewJobFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [validationBusy, setValidationBusy] = useState(false);
  const [error, setError] = useState<UserFacingError | null>(null);
  const [success, setSuccess] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [jsonName, setJsonName] = useState("");
  const [validation, setValidation] = useState<ClaudeValidationResult | null>(null);
  const [sourceValidation, setSourceValidation] = useState<ReviewSourceValidation | null>(null);
  const [decisions, setDecisions] = useState<Record<string, FindingDecision>>({});
  const [commentOutputFolder, setCommentOutputFolder] = useState("");
  const [commentOutputName, setCommentOutputName] = useState("");
  const [commentResult, setCommentResult] = useState<{ outputPath: string; reportPath: string } | null>(null);

  useEffect(() => {
    if (!loaded) return;
    setOutputFolder(settings.lastOutputFolder ?? "");
    setCommentOutputFolder(settings.lastOutputFolder ?? "");
    setShowSkillSetup(!settings.skillInstalled);
  }, [loaded]);

  useEffect(() => {
    if (!loaded || preferencesReady || styleTouchedRef.current) return;
    setCommentStyle((settings.commenter?.selectedCommentStyle as CommentStyleId | undefined) ?? "hl-concise");
    setCustomStyle(cloneStyle(settings.commenter?.customStyle ?? defaultStyle));
    setSavedStyles(settings.commenter?.savedStylePresets ?? []);
    setPreferencesReady(true);
  }, [loaded, preferencesReady, settings]);

  useEffect(() => {
    if (!preferencesReady) return;
    updateSettings({
      commenter: {
        selectedCommentStyle: commentStyle,
        customStyle,
        savedStylePresets: savedStyles
      }
    });
  }, [commentStyle, customStyle, savedStyles, preferencesReady, updateSettings]);

  useEffect(() => {
    if (source && !commentOutputName) {
      const ext = extension(source.name) || ".pdf";
      setCommentOutputName(`${withoutExtension(source.name)}_commented${ext}`);
    }
  }, [source, commentOutputName]);

  const localJobPath = packageResult?.localJobPath ?? resumeJob?.path ?? "";
  const style = useMemo(() => styleForChoice(commentStyle, customStyle), [commentStyle, customStyle]);
  const validationState = reviewValidationState(validation, sourceValidation, decisions);
  const approvedFindings = validation ? approvedFindingInputs(validation, decisions) : [];
  const pendingReview = hasPendingDecisions(validation, decisions);
  const showReviewPanel = Boolean(validation && (validation.summary.attention || validation.summary.invalid || pendingReview));
  const skillInstalled = Boolean(settings.skillInstalled);
  const sourceSupported = source?.supportStatus === "verified";
  const sourceMismatchError =
    sourceValidation && !sourceValidation.ok
      ? {
          title: "Source file does not match the review job.",
          file: source?.name,
          sourceChanged: sourceValidation.sourceChanged ? "Yes" : "Unknown",
          nextStep: "Select the original source file used to create the review package.",
          details: sourceValidation.message
        } satisfies UserFacingError
      : null;

  useEffect(() => {
    if (!localJobPath || !jsonText.trim()) {
      setValidation(null);
      setDecisions({});
      return;
    }
    const timer = window.setTimeout(() => {
      setValidationBusy(true);
      window.hl
        .validateClaudeResult({ localJobPath, jsonText })
        .then((result) => {
          setValidation(result);
          setDecisions(defaultDecisions(result));
          if (result.errors.length) {
            setError({
              title: "Claude result was rejected.",
              file: jsonName || "hl_comments.json",
              sourceChanged: "No",
              nextStep: "Show details, correct the JSON in the approved LLM environment, then paste or browse again.",
              details: result.errors.join("\n")
            });
          } else {
            setError(null);
          }
        })
        .catch((validationError) =>
          setError(
            userError({
              action: "Claude result validation failed.",
              file: jsonName || "hl_comments.json",
              error: validationError,
              nextStep: "Show details, confirm this is the returned hl_comments.json file, then try again."
            })
          )
        )
        .finally(() => setValidationBusy(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [localJobPath, jsonText, jsonName]);

  useEffect(() => {
    if (!localJobPath || !source) {
      setSourceValidation(null);
      return;
    }
    let active = true;
    window.hl
      .validateReviewSource({ localJobPath, sourcePath: source.path })
      .then((result) => {
        if (active) setSourceValidation(result);
      })
      .catch((sourceError) => {
        if (!active) return;
        setSourceValidation({
          ok: false,
          expectedSha256: "",
          sourceChanged: false,
          message: sourceError instanceof Error ? sourceError.message : String(sourceError)
        });
      });
    return () => {
      active = false;
    };
  }, [localJobPath, source?.path]);

  async function browseSource() {
    setError(null);
    const selected = await window.hl.selectDocument();
    if (selected) setSource(selected);
  }

  async function chooseOutput(setter: (folder: string) => void) {
    const folder = await window.hl.selectFolder();
    if (folder) {
      setter(folder);
      updateSettings({ lastOutputFolder: folder });
    }
  }

  async function buildSkill() {
    setError(null);
    setBusy(true);
    try {
      const result = await window.hl.buildSkillZip({ defaultFolder: outputFolder || settings.lastOutputFolder });
      if (!result) return;
      setSuccess(`Skill ZIP saved: ${fileName(result.zipPath)}`);
      setShowSkillSetup(true);
    } catch (buildError) {
      setError(
        userError({
          action: "Skill ZIP could not be saved.",
          file: "HL-Commenter-Skill.zip",
          error: buildError,
          nextStep: "Show details, choose a writable Save As location, then try again."
        })
      );
    } finally {
      setBusy(false);
    }
  }

  async function createReviewPackage() {
    if (!source || !outputFolder) return;
    setBusy(true);
    setError(null);
    setSuccess("");
    try {
      const result = await window.hl.prepareReview({
        sourcePath: source.path,
        outputFolder,
        reviewInstructions,
        style
      });
      setPackageResult(result);
      setResumeJob(null);
      setCommentOutputFolder(outputFolder);
      setStep(2);
      setSuccess("Review package created.");
    } catch (packageError) {
      setError(
        userError({
          action: "Review package could not be created.",
          file: source.path,
          error: packageError,
          nextStep: "Show details, confirm the file is supported and the output folder is writable, then try again."
        })
      );
    } finally {
      setBusy(false);
    }
  }

  async function importJson() {
    const selected = await window.hl.selectJsonFile();
    if (selected) {
      setJsonText(selected.text);
      setJsonName(selected.name);
    }
  }

  async function importReviewJob() {
    const selected = await window.hl.selectReviewJobFile();
    if (selected) {
      setPackageResult(null);
      setResumeJob(selected);
      setStep(2);
      setSuccess(`Review job loaded: ${selected.sourceFilename}`);
    }
  }

  async function createCommentedFile() {
    if (!source || !localJobPath || !commentOutputFolder || !validation || validationState !== "ready") return;
    setBusy(true);
    setError(null);
    setSuccess("");
    try {
      const result = await window.hl.createCommentedPdf({
        sourcePath: source.path,
        localJobPath,
        claudeJsonText: jsonText,
        outputFolder: commentOutputFolder,
        outputFilename: commentOutputName,
        approvedFindings
      });
      setCommentResult({ outputPath: result.outputPath, reportPath: result.reportPath });
      setSuccess("Commented file created.");
    } catch (createError) {
      setError(
        userError({
          action: "Commented file could not be created.",
          file: source.path,
          error: createError,
          nextStep: "Show details, confirm approved findings still validate and choose a writable output folder, then try again.",
          sourceChanged: sourceValidation?.sourceChanged ? "Yes" : "No"
        })
      );
    } finally {
      setBusy(false);
    }
  }

  function selectReviewType(next: ReviewTypeId) {
    setReviewType(next);
    const preset = reviewTypes.find((item) => item.id === next);
    setReviewInstructions(preset?.instructions ?? "");
  }

  function selectAdditionalReview(instructions: string) {
    setReviewType("custom");
    setReviewInstructions(instructions);
  }

  function updateCustomStyle(patch: Partial<StyleConfig>) {
    styleTouchedRef.current = true;
    setPreferencesReady(true);
    setCommentStyle("custom");
    setCustomStyle((current) => ({ ...current, ...patch }));
  }

  function chooseCommentStyle(next: CommentStyleId) {
    styleTouchedRef.current = true;
    setPreferencesReady(true);
    setCommentStyle(next);
  }

  function saveNamedStyle() {
    const name = newStyleName.trim();
    if (!name) return;
    const preset: SavedStylePreset = {
      id: crypto.randomUUID(),
      name,
      style: cloneStyle(style)
    };
    setSavedStyles((current) => [...current.filter((item) => item.name !== name), preset]);
    setNewStyleName("");
    setSuccess("Style preset saved.");
  }

  function applySavedStyle(preset: SavedStylePreset) {
    setCommentStyle("custom");
    setCustomStyle(cloneStyle(preset.style));
  }

  return (
    <div className="workspace">
      <PageHeader
        title="Commenter"
        description="Prepare a review package, then apply approved structured comments locally."
        actions={
          <>
            <button className="secondary" type="button" onClick={importReviewJob}>
              <FileJson size={16} /> Resume existing review
            </button>
            <div className="stepper" aria-label="Commenter steps">
              <button className={step === 1 ? "active" : ""} onClick={() => setStep(1)}>
                <span>1</span> Prepare review
              </button>
              <button className={step === 2 ? "active" : ""} onClick={() => setStep(2)}>
                <span>2</span> Apply comments
              </button>
            </div>
          </>
        }
      />

      <ErrorBanner error={error ?? sourceMismatchError} />
      <StatusBanner success={success} />
      <LoadingOverlay active={busy || validationBusy} label={validationBusy ? "Validating locally" : "Processing locally"} />

      {step === 1 ? (
        <div className="flow-stack">
          <SkillSetupCard
            installed={skillInstalled}
            expanded={showSkillSetup}
            onToggle={() => setShowSkillSetup((value) => !value)}
            onBuild={buildSkill}
            onInstalledChange={(installed) => {
              updateSettings({ skillInstalled: installed });
              setShowSkillSetup(!installed);
            }}
            busy={busy}
          />

          <section className="panel">
            <div className="panel-title">
              <h3>Create review package</h3>
            </div>
            <div className="normal-workflow">
              <section>
                <div className="field-label">Source document</div>
                <DropZone
                  label="Source document drop zone"
                  onFiles={async (paths) => {
                    if (paths[0]) setSource(await window.hl.getMetadata(paths[0]));
                  }}
                >
                  {source ? (
                    <FileCard
                      file={source}
                      action={
                        <button className="text-button" type="button" onClick={() => setSource(null)}>
                          Remove
                        </button>
                      }
                    />
                  ) : (
                    <EmptyDrop label="Browse or drop document" onBrowse={browseSource} />
                  )}
                </DropZone>
              </section>

              <FieldGroup label="Review type">
                <div className="choice-grid">
                  {reviewTypes.map((option) => (
                    <label key={option.id} className="choice-card">
                      <input
                        type="radio"
                        name="review-type"
                        checked={reviewType === option.id}
                        onChange={() => selectReviewType(option.id)}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
                {reviewType === "custom" ? (
                  <textarea
                    className="large-textarea"
                    value={reviewInstructions}
                    onChange={(event) => setReviewInstructions(event.target.value)}
                    placeholder="Custom review instructions"
                  />
                ) : null}
              </FieldGroup>

              <FieldGroup label="Comment style">
                <div className="choice-grid">
                  {commentStyles.map((option) => (
                    <label key={option.id} className="choice-card">
                      <input
                        type="radio"
                        name="comment-style"
                        checked={commentStyle === option.id}
                        onChange={() => chooseCommentStyle(option.id)}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </FieldGroup>

              <FolderField value={outputFolder} onBrowse={() => chooseOutput(setOutputFolder)} />

              <AdvancedReviewSettings
                style={customStyle}
                onStyleChange={updateCustomStyle}
                savedStyles={savedStyles}
                newStyleName={newStyleName}
                onNewStyleNameChange={setNewStyleName}
                onSaveStyle={saveNamedStyle}
                onApplyStyle={applySavedStyle}
                onDeleteStyle={(id) => setSavedStyles((current) => current.filter((item) => item.id !== id))}
                onAdditionalReview={selectAdditionalReview}
              />

              <div className="footer-actions">
                <button className="primary" disabled={!source || !sourceSupported || !outputFolder || busy} onClick={createReviewPackage}>
                  <FileCheck2 size={16} /> Create review package
                </button>
              </div>
            </div>
          </section>

          {packageResult ? (
            <section className="panel result-panel">
              <h3>Review package created</h3>
              <div className="inline-actions">
                <button className="secondary" onClick={() => window.hl.openPath(packageResult.outputRoot)}>
                  <FolderOpen size={16} /> Open output folder
                </button>
                <button className="secondary" onClick={async () => window.hl.copyText(await window.hl.readTextFile(packageResult.promptPath))}>
                  <Clipboard size={16} /> Copy prompt
                </button>
                <button className="secondary" onClick={buildSkill}>
                  <Download size={16} /> Save Skill ZIP
                </button>
                <button className="primary" onClick={() => setStep(2)}>
                  Continue to Step 2
                </button>
              </div>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="flow-stack">
          {!packageResult ? (
            <section className="panel resume-panel">
              <div className="panel-title">
                <h3>Resume existing review</h3>
                <button className="secondary" type="button" onClick={importReviewJob}>
                  <FileJson size={16} /> Browse review-job.hlreview
                </button>
              </div>
              {resumeJob ? (
                <div className="resume-summary">
                  <strong>{resumeJob.name}</strong>
                  <span>{resumeJob.sourceFilename}</span>
                  <small>Request {resumeJob.requestId}</small>
                </div>
              ) : (
                <p className="muted">Select the local review job saved in Keep_Local.</p>
              )}
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-title">
              <h3>Apply comments</h3>
              {validationState ? <ValidationBadge state={validationState} /> : null}
            </div>
            <div className="apply-grid">
              <section className="apply-json">
                <div className="panel-title compact">
                  <h4>Claude result JSON</h4>
                  <button className="secondary" onClick={importJson}>
                    <FileJson size={16} /> Browse
                  </button>
                </div>
                <DropZone
                  label="Claude result JSON drop zone"
                  onFiles={async (paths) => {
                    if (paths[0]) {
                      setJsonText(await window.hl.readTextFile(paths[0]));
                      setJsonName(fileName(paths[0]));
                    }
                  }}
                >
                  <textarea
                    className="json-textarea"
                    value={jsonText}
                    onChange={(event) => {
                      setJsonText(event.target.value);
                      setJsonName(jsonName || "pasted hl_comments.json");
                    }}
                    placeholder="Paste hl_comments.json"
                  />
                </DropZone>
              </section>

              <section>
                <div className="field-label">Original document</div>
                <DropZone
                  label="Original document drop zone"
                  onFiles={async (paths) => {
                    if (paths[0]) setSource(await window.hl.getMetadata(paths[0]));
                  }}
                >
                  {source ? <FileCard file={source} /> : <EmptyDrop label="Browse or drop original" onBrowse={browseSource} />}
                </DropZone>
              </section>

              <section className="output-fields">
                <label className="field">
                  <span>Output filename</span>
                  <input className="input" value={commentOutputName} onChange={(event) => setCommentOutputName(event.target.value)} />
                </label>
                <FolderField value={commentOutputFolder} onBrowse={() => chooseOutput(setCommentOutputFolder)} />
              </section>
            </div>

            {validation?.ignoredExtraText ? <p className="notice">Extra text around the JSON was ignored.</p> : null}
            {showReviewPanel && validation ? (
              <ReviewFindingsPanel validation={validation} decisions={decisions} onDecisionChange={setDecisions} />
            ) : null}

            <div className="footer-actions">
              <button
                className="primary"
                disabled={
                  !source ||
                  !sourceSupported ||
                  !localJobPath ||
                  !commentOutputFolder ||
                  !commentOutputName ||
                  validationState !== "ready" ||
                  approvedFindings.length === 0 ||
                  busy
                }
                onClick={createCommentedFile}
              >
                <FileCheck2 size={16} /> Create commented file
              </button>
            </div>

            {commentResult ? (
              <div className="result-panel">
                <h4>Created</h4>
                <p>{fileName(commentResult.outputPath)}</p>
                <div className="inline-actions">
                  <button className="secondary" onClick={() => window.hl.openPath(commentResult.outputPath)}>
                    <FolderOpen size={16} /> Open file
                  </button>
                  <button className="secondary" onClick={() => window.hl.openPath(commentResult.reportPath)}>
                    <FileJson size={16} /> Open report
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}

function SkillSetupCard({
  installed,
  expanded,
  onToggle,
  onBuild,
  onInstalledChange,
  busy
}: {
  installed: boolean;
  expanded: boolean;
  onToggle: () => void;
  onBuild: () => void;
  onInstalledChange: (installed: boolean) => void;
  busy: boolean;
}) {
  if (installed && !expanded) {
    return (
      <section className="setup-strip">
        <span>
          <Check size={16} /> Skill installed
        </span>
        <button className="ghost" type="button" onClick={onToggle}>
          <HelpCircle size={16} /> Setup
        </button>
      </section>
    );
  }

  return (
    <section className="panel setup-panel">
      <div className="panel-title">
        <h3>HL Commenter Skill</h3>
        {installed ? (
          <button className="text-button" type="button" onClick={onToggle}>
            Collapse
          </button>
        ) : (
          <span>One-time setup</span>
        )}
      </div>
      <div className="inline-actions">
        <button className="secondary" type="button" onClick={onBuild} disabled={busy}>
          <Download size={16} /> Save Skill ZIP
        </button>
      </div>
      <ol className="compact-list">
        <li>Save the ZIP to a known folder.</li>
        <li>Install or enable it in the approved Claude environment.</li>
        <li>Return here and mark the Skill installed.</li>
      </ol>
      <label className="check-row">
        <input type="checkbox" checked={installed} onChange={(event) => onInstalledChange(event.target.checked)} />
        I installed this Skill
      </label>
    </section>
  );
}

function AdvancedReviewSettings({
  style,
  onStyleChange,
  savedStyles,
  newStyleName,
  onNewStyleNameChange,
  onSaveStyle,
  onApplyStyle,
  onDeleteStyle,
  onAdditionalReview
}: {
  style: StyleConfig;
  onStyleChange: (patch: Partial<StyleConfig>) => void;
  savedStyles: SavedStylePreset[];
  newStyleName: string;
  onNewStyleNameChange: (value: string) => void;
  onSaveStyle: () => void;
  onApplyStyle: (preset: SavedStylePreset) => void;
  onDeleteStyle: (id: string) => void;
  onAdditionalReview: (instructions: string) => void;
}) {
  return (
    <AdvancedPanel>
      <div className="advanced-grid">
        <section>
          <h4>Wording signals</h4>
          <div className="checkbox-grid">
            {wordingSignals.map((signal) => (
              <label key={signal}>
                <input
                  type="checkbox"
                  checked={style.signals.includes(signal)}
                  onChange={(event) =>
                    onStyleChange({
                      wording_mode: "guided",
                      signals: event.target.checked
                        ? [...style.signals, signal]
                        : style.signals.filter((item) => item !== signal)
                    })
                  }
                />
                {labelize(signal)}
              </label>
            ))}
          </div>
          <div className="two-col">
            <SelectField
              label="Formality"
              value={style.formality}
              onChange={(value) => onStyleChange({ wording_mode: value === "automatic" ? "automatic" : "guided", formality: value as StyleConfig["formality"] })}
              options={[
                { value: "automatic", label: "Automatic" },
                { value: "professional", label: "Professional" },
                { value: "formal", label: "Formal" }
              ]}
            />
            <SelectField
              label="Maximum comment length"
              value={String(style.max_words ?? "automatic")}
              onChange={(value) => onStyleChange({ wording_mode: value === "automatic" ? style.wording_mode : "guided", max_words: value === "automatic" ? null : Number(value) })}
              options={[
                { value: "automatic", label: "Automatic" },
                { value: "25", label: "Brief" },
                { value: "45", label: "Standard" },
                { value: "80", label: "Detailed" }
              ]}
            />
          </div>
        </section>

        <section>
          <h4>Custom format</h4>
          <input
            className="input"
            value={style.format_template}
            onChange={(event) => onStyleChange({ wording_mode: "guided", format_template: event.target.value })}
          />
          <div className="token-list" aria-label="Format tokens">
            {formatTokens.map((token) => (
              <code key={token}>{token}</code>
            ))}
          </div>
          <div className="preview-line">
            <span>Preview</span>
            <strong>{renderPreview(style.format_template)}</strong>
          </div>
        </section>

        <section>
          <h4>Style examples</h4>
          <StyleExamples style={style} onStyleChange={onStyleChange} />
        </section>

        <section>
          <h4>Named-style management</h4>
          <div className="save-style-row">
            <input
              className="input"
              value={newStyleName}
              onChange={(event) => onNewStyleNameChange(event.target.value)}
              placeholder="Preset name"
            />
            <button className="secondary" type="button" onClick={onSaveStyle}>
              Save
            </button>
          </div>
          <div className="saved-style-list">
            {savedStyles.map((preset) => (
              <div key={preset.id} className="saved-style-row">
                <span>{preset.name}</span>
                <button className="secondary" type="button" onClick={() => onApplyStyle(preset)}>
                  Apply
                </button>
                <button className="icon-button" type="button" aria-label={`Delete ${preset.name}`} onClick={() => onDeleteStyle(preset.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="advanced-wide">
          <h4>Additional review presets</h4>
          <div className="preset-row">
            {additionalReviewPresets.map((preset) => (
              <button className="chip" type="button" key={preset.label} onClick={() => onAdditionalReview(preset.instructions)}>
                {preset.label}
              </button>
            ))}
          </div>
        </section>
      </div>
    </AdvancedPanel>
  );
}

function StyleExamples({
  style,
  onStyleChange
}: {
  style: StyleConfig;
  onStyleChange: (patch: Partial<StyleConfig>) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <div className="example-input">
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Example comment" />
        <button
          className="secondary icon-only"
          aria-label="Add example"
          type="button"
          onClick={() => {
            if (!draft.trim()) return;
            onStyleChange({ wording_mode: "guided", examples: [...style.examples, draft.trim()] });
            setDraft("");
          }}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="example-list">
        {style.examples.map((example, index) => (
          <div key={`${example}-${index}`} className="example-row">
            <span>{example}</span>
            <button
              className="icon-button"
              aria-label="Remove example"
              type="button"
              onClick={() => onStyleChange({ examples: style.examples.filter((_, itemIndex) => itemIndex !== index) })}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ValidationBadge({ state }: { state: "ready" | "needs-review" | "rejected" }) {
  const label = state === "ready" ? "Ready to apply" : state === "needs-review" ? "Needs review" : "Rejected";
  return <span className={`validation-badge ${state}`}>{label}</span>;
}

function reviewValidationState(
  validation: ClaudeValidationResult | null,
  sourceValidation: ReviewSourceValidation | null,
  decisions: Record<string, FindingDecision>
): "ready" | "needs-review" | "rejected" | null {
  if (sourceValidation && !sourceValidation.ok) return "rejected";
  if (!validation) return null;
  if (validation.errors.length) return "rejected";
  if (hasPendingDecisions(validation, decisions)) return "needs-review";
  return approvedFindingInputs(validation, decisions).length ? "ready" : "rejected";
}

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Clipboard,
  Download,
  FileCheck2,
  FileJson,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type {
  ClaudeValidationResult,
  FileMetadata,
  PreflightFileResult,
  ProcessingMode,
  ProgressEvent,
  ReviewPackageResult,
  StyleConfig
} from "../shared/types";

type Tab = "commenter" | "preflight";
type CommentLength = "automatic" | "brief" | "standard" | "detailed";

interface QueueRow {
  id: string;
  metadata: FileMetadata;
  mode: ProcessingMode;
  status: string;
  progress: number;
  result?: PreflightFileResult;
}

const wordingSignals = ["concise", "neutral", "formal", "question-led", "action-oriented", "evidence-first"];
const reviewPresets = [
  "Proofread",
  "Numbers and consistency",
  "Dates, periods, currencies, and units",
  "Defined terms and naming",
  "Cross-references",
  "Tone and clarity",
  "Custom review"
];
const formatPresets = [
  { label: "Comment only", template: "{comment}" },
  { label: "Value first", template: "[{value}] {comment}" },
  { label: "Page reference", template: "{comment} - Page {page}/{total_pages}" },
  { label: "Value and page", template: "[{value}] {comment} - Page {page}/{total_pages}" },
  { label: "Issue and action", template: "[{category}] {comment} Suggested: {suggested_replacement}" },
  { label: "Custom format", template: "" }
];
const processingModes: Array<{ label: string; value: ProcessingMode; note: string }> = [
  {
    label: "Text only",
    value: "text-only",
    note: "Graphs, diagrams, images, and layout-dependent information may be omitted."
  },
  {
    label: "Text + visual pages",
    value: "text-visual",
    note: "Recommended"
  },
  {
    label: "Text + every page",
    value: "text-all-pages",
    note: "Complete visual reference"
  }
];

export default function App() {
  const [tab, setTab] = useState<Tab>("commenter");

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <img src="./brand/hl-logo-horizontal.svg" alt="Houlihan Lokey" className="brand-logo" />
          <div>
            <h1>HL Intelligence</h1>
            <p>Processed locally. No documents are uploaded by HL Intelligence.</p>
          </div>
        </div>
        <nav className="tabs" aria-label="Primary">
          <button className={tab === "commenter" ? "active" : ""} onClick={() => setTab("commenter")}>
            Commenter
          </button>
          <button className={tab === "preflight" ? "active" : ""} onClick={() => setTab("preflight")}>
            LLM Preflight
          </button>
        </nav>
      </header>
      <main>{tab === "commenter" ? <Commenter /> : <Preflight />}</main>
    </div>
  );
}

function Commenter() {
  const [step, setStep] = useState<1 | 2>(1);
  const [source, setSource] = useState<FileMetadata | null>(null);
  const [outputFolder, setOutputFolder] = useState("");
  const [reviewInstructions, setReviewInstructions] = useState("");
  const [signals, setSignals] = useState<string[]>([]);
  const [formality, setFormality] = useState<StyleConfig["formality"]>("automatic");
  const [length, setLength] = useState<CommentLength>("automatic");
  const [formatTemplate, setFormatTemplate] = useState("{comment}");
  const [formatPreset, setFormatPreset] = useState("Comment only");
  const [examples, setExamples] = useState<string[]>([]);
  const [exampleDraft, setExampleDraft] = useState("");
  const [skillInstalled, setSkillInstalled] = useState(false);
  const [showSkillHelp, setShowSkillHelp] = useState(false);
  const [packageResult, setPackageResult] = useState<ReviewPackageResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [validation, setValidation] = useState<ClaudeValidationResult | null>(null);
  const [reviewFirst, setReviewFirst] = useState(false);
  const [commentOutputFolder, setCommentOutputFolder] = useState("");
  const [commentOutputName, setCommentOutputName] = useState("");
  const [commentResult, setCommentResult] = useState<{ outputPath: string; reportPath: string } | null>(null);

  useEffect(() => {
    window.hl.getSettings().then((settings) => {
      if (settings.lastOutputFolder) {
        setOutputFolder(settings.lastOutputFolder);
        setCommentOutputFolder(settings.lastOutputFolder);
      }
    });
  }, []);

  useEffect(() => {
    if (source && !commentOutputName) {
      const ext = extension(source.name) || ".pdf";
      setCommentOutputName(`${withoutExtension(source.name)}_commented${ext}`);
    }
  }, [source, commentOutputName]);

  const style = useMemo<StyleConfig>(
    () => ({
      wording_mode: signals.length || formality !== "automatic" || length !== "automatic" ? "guided" : "automatic",
      signals,
      formality,
      max_words: length === "brief" ? 25 : length === "standard" ? 45 : length === "detailed" ? 80 : null,
      format_template: formatTemplate,
      examples
    }),
    [signals, formality, length, formatTemplate, examples]
  );

  const preview = renderPreview(formatTemplate);

  async function browseSource() {
    setError("");
    const selected = await window.hl.selectDocument();
    if (selected) setSource(selected);
  }

  async function chooseOutput(setter: (folder: string) => void) {
    const folder = await window.hl.selectFolder();
    if (folder) {
      setter(folder);
      await window.hl.saveSettings({ lastOutputFolder: folder });
    }
  }

  async function buildSkill() {
    setError("");
    setBusy(true);
    try {
      const result = await window.hl.buildSkillZip();
      setSuccess(`Skill ZIP created: ${fileName(result.zipPath)}`);
      await window.hl.openPath(result.zipPath);
    } catch (buildError) {
      setError(messageOf(buildError));
    } finally {
      setBusy(false);
    }
  }

  async function createReviewPackage() {
    if (!source || !outputFolder) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await window.hl.prepareReview({
        sourcePath: source.path,
        outputFolder,
        reviewInstructions,
        style
      });
      setPackageResult(result);
      setCommentOutputFolder(outputFolder);
      setStep(2);
      setSuccess("Claude Review Package created.");
    } catch (packageError) {
      setError(messageOf(packageError));
    } finally {
      setBusy(false);
    }
  }

  async function importJson() {
    const selected = await window.hl.selectJsonFile();
    if (selected) setJsonText(selected.text);
  }

  async function validateJson() {
    if (!packageResult || !jsonText.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.hl.validateClaudeResult({
        localJobPath: packageResult.localJobPath,
        jsonText
      });
      setValidation(result);
      if (!result.ok && result.errors.length) setError(result.errors.join(" "));
    } catch (validationError) {
      setError(messageOf(validationError));
    } finally {
      setBusy(false);
    }
  }

  async function createCommentedFile() {
    if (!source || !packageResult || !commentOutputFolder || !validation || !validation.ok) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await window.hl.createCommentedPdf({
        sourcePath: source.path,
        localJobPath: packageResult.localJobPath,
        claudeJsonText: jsonText,
        outputFolder: commentOutputFolder,
        outputFilename: commentOutputName
      });
      setCommentResult({ outputPath: result.outputPath, reportPath: result.reportPath });
      setSuccess("Commented PDF created.");
    } catch (createError) {
      setError(messageOf(createError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace">
      <section className="section-head">
        <div>
          <h2>Commenter</h2>
          <p>Prepare a reviewed package, then apply the returned structured comments locally.</p>
        </div>
        <div className="stepper" aria-label="Commenter steps">
          <button className={step === 1 ? "active" : ""} onClick={() => setStep(1)}>
            <span>1</span> Prepare Claude Review
          </button>
          <button className={step === 2 ? "active" : ""} onClick={() => setStep(2)}>
            <span>2</span> Create Commented File
          </button>
        </div>
      </section>

      <Status error={error} success={success} />
      <GuidePanel
        title={step === 1 ? "Step 1 guide" : "Step 2 guide"}
        steps={
          step === 1
            ? [
                "Install the HL Commenter Skill once, or confirm it is already installed.",
                "Select the original PDF and describe what Claude should review.",
                "Choose comment wording, format, and optional style examples only if needed.",
                "Select an output folder and create the review package.",
                "In Claude, upload only the files in Upload_to_Claude and paste the prepared prompt."
              ]
            : [
                "Import the hl_comments.json file from Claude by pasting it or browsing for it.",
                "Use the original PDF from Step 1, or browse for the same source file.",
                "Validate the result before creating the commented PDF.",
                "Create the commented file; HL Intelligence writes a new PDF and never overwrites the source.",
                "Open the generated report if any comments were skipped."
              ]
        }
      />
      <LoadingOverlay active={busy} label="Processing locally" />

      {step === 1 ? (
        <div className="flow-grid">
          <section className="panel">
            <div className="panel-title">
              <h3>Install the HL Commenter Skill</h3>
              <span>One-time setup</span>
            </div>
            <div className="inline-actions">
              <button className="secondary" onClick={buildSkill} disabled={busy}>
                <Download size={16} /> Download HL Commenter Skill
              </button>
              <button className="ghost" onClick={() => setShowSkillHelp((value) => !value)}>
                Show installation instructions
              </button>
            </div>
            {showSkillHelp && (
              <ol className="compact-list">
                <li>Download the Skill ZIP from HL Intelligence.</li>
                <li>Install or enable it in the approved Claude environment.</li>
                <li>Use the same Skill for every document; document-specific settings are in review-config.json.</li>
              </ol>
            )}
            <label className="check-row">
              <input type="checkbox" checked={skillInstalled} onChange={(event) => setSkillInstalled(event.target.checked)} />
              I already installed this Skill
            </label>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>Source document</h3>
              {source ? <button className="text-button" onClick={() => setSource(null)}>Remove</button> : null}
            </div>
            <DropZone onFiles={async (paths) => paths[0] && setSource(await window.hl.getMetadata(paths[0]))}>
              {source ? <FileSummary file={source} /> : <EmptyDrop icon={<Upload />} label="Browse document or drop a PDF" onBrowse={browseSource} />}
            </DropZone>
          </section>

          <section className="panel wide">
            <div className="panel-title">
              <h3>Review request</h3>
            </div>
            <div className="preset-row">
              {reviewPresets.map((preset) => (
                <button
                  key={preset}
                  className="chip"
                  onClick={() =>
                    setReviewInstructions((current) => [current.trim(), preset === "Custom review" ? "" : preset].filter(Boolean).join("\n"))
                  }
                >
                  {preset}
                </button>
              ))}
            </div>
            <textarea
              className="large-textarea"
              value={reviewInstructions}
              onChange={(event) => setReviewInstructions(event.target.value)}
              placeholder="What should Claude review?"
            />
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>Comment wording</h3>
            </div>
            <label className="radio-card">
              <input
                type="radio"
                checked={signals.length === 0 && formality === "automatic" && length === "automatic"}
                onChange={() => {
                  setSignals([]);
                  setFormality("automatic");
                  setLength("automatic");
                }}
              />
              <span>
                <strong>Automatic wording</strong>
                <small>Let Claude choose concise professional wording.</small>
              </span>
            </label>
            <div className="field-label">Wording signals</div>
            <div className="checkbox-grid">
              {wordingSignals.map((signal) => (
                <label key={signal}>
                  <input
                    type="checkbox"
                    checked={signals.includes(signal)}
                    onChange={(event) =>
                      setSignals((current) =>
                        event.target.checked ? [...current, signal] : current.filter((item) => item !== signal)
                      )
                    }
                  />
                  {labelize(signal)}
                </label>
              ))}
            </div>
            <div className="two-col">
              <Select label="Formality" value={formality} onChange={(value) => setFormality(value as StyleConfig["formality"])} options={["automatic", "professional", "formal"]} />
              <Select label="Maximum length" value={length} onChange={(value) => setLength(value as CommentLength)} options={["automatic", "brief", "standard", "detailed"]} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>Comment format</h3>
            </div>
            <div className="format-list">
              {formatPresets.map((preset) => (
                <label key={preset.label}>
                  <input
                    type="radio"
                    checked={formatPreset === preset.label}
                    onChange={() => {
                      setFormatPreset(preset.label);
                      if (preset.template) setFormatTemplate(preset.template);
                    }}
                  />
                  {preset.label}
                </label>
              ))}
            </div>
            <input
              className="input"
              value={formatTemplate}
              onChange={(event) => {
                setFormatTemplate(event.target.value);
                setFormatPreset("Custom format");
              }}
            />
            <div className="preview-line">
              <span>Preview</span>
              <strong>{preview}</strong>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>Style examples</h3>
              <button
                className="text-button"
                onClick={() => {
                  localStorage.setItem("hl-comment-style", JSON.stringify(examples));
                  setSuccess("Style examples saved locally.");
                }}
              >
                Save style
              </button>
            </div>
            <p className="muted">Claude will use these examples as style guidance, not as document content.</p>
            <div className="example-input">
              <textarea value={exampleDraft} onChange={(event) => setExampleDraft(event.target.value)} placeholder="Paste an example comment" />
              <button
                className="secondary icon-only"
                aria-label="Add example"
                onClick={() => {
                  if (exampleDraft.trim()) {
                    setExamples((current) => [...current, exampleDraft.trim()]);
                    setExampleDraft("");
                  }
                }}
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="example-list">
              {examples.map((example, index) => (
                <div key={`${example}-${index}`} className="example-row">
                  <span>{example}</span>
                  <button aria-label="Move example up" onClick={() => setExamples(move(examples, index, index - 1))}><ArrowUp size={14} /></button>
                  <button aria-label="Move example down" onClick={() => setExamples(move(examples, index, index + 1))}><ArrowDown size={14} /></button>
                  <button aria-label="Remove example" onClick={() => setExamples(examples.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          </section>

          <section className="panel wide">
            <div className="panel-title">
              <h3>Generate review files</h3>
            </div>
            <FolderField value={outputFolder} onBrowse={() => chooseOutput(setOutputFolder)} />
            <div className="footer-actions">
              <button className="primary" disabled={!source || !outputFolder || busy} onClick={createReviewPackage}>
                <FileCheck2 size={16} /> Create Claude Review Package
              </button>
            </div>
            {packageResult && (
              <div className="result-panel">
                <h4>Next steps</h4>
                <ol>
                  <li>Install or enable the HL Commenter Skill.</li>
                  <li>Open the approved Claude environment.</li>
                  <li>Upload the files shown under Upload_to_Claude.</li>
                  <li>Paste the prepared prompt.</li>
                  <li>Ask Claude to create hl_comments.json.</li>
                  <li>Download that file and return to Step 2.</li>
                </ol>
                <div className="inline-actions">
                  <button className="secondary" onClick={() => window.hl.openPath(packageResult.outputRoot)}><FolderOpen size={16} /> Open output folder</button>
                  <button className="secondary" onClick={async () => window.hl.copyText(await window.hl.readTextFile(packageResult.promptPath))}><Clipboard size={16} /> Copy prompt</button>
                  <button className="secondary" onClick={buildSkill}><Download size={16} /> Download Skill</button>
                  <button className="primary" onClick={() => setStep(2)}>Continue to Step 2</button>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="flow-grid">
          <section className="panel wide">
            <div className="panel-title">
              <h3>Claude result</h3>
              <button className="secondary" onClick={importJson}><FileJson size={16} /> Browse for hl_comments.json</button>
            </div>
            <DropZone
              onFiles={async (paths) => {
                if (paths[0]) setJsonText(await window.hl.readTextFile(paths[0]));
              }}
            >
              <textarea
                className="json-textarea"
                value={jsonText}
                onChange={(event) => {
                  setJsonText(event.target.value);
                  setValidation(null);
                }}
                placeholder="Paste hl_comments.json"
              />
            </DropZone>
            <div className="footer-actions">
              <button className="secondary" disabled={!packageResult || !jsonText.trim() || busy} onClick={validateJson}>
                <Check size={16} /> Validate result
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>Original source document</h3>
              <button className="text-button" onClick={browseSource}>Browse document</button>
            </div>
            {source ? <FileSummary file={source} /> : <p className="muted">Use the source from Step 1 or browse for the original PDF.</p>}
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>Output</h3>
            </div>
            <FolderField value={commentOutputFolder} onBrowse={() => chooseOutput(setCommentOutputFolder)} />
            <label className="field">
              <span>Suggested filename</span>
              <input className="input" value={commentOutputName} onChange={(event) => setCommentOutputName(event.target.value)} />
            </label>
          </section>

          <section className="panel wide">
            <div className="panel-title">
              <h3>Result summary</h3>
              <label className="check-row compact">
                <input type="checkbox" checked={reviewFirst} onChange={(event) => setReviewFirst(event.target.checked)} />
                Review comments first
              </label>
            </div>
            {validation?.ignoredExtraText && <p className="notice">Extra text around the JSON was ignored.</p>}
            <Summary validation={validation} />
            {reviewFirst && validation && (
              <div className="validation-list">
                {validation.validations.map((item) => (
                  <div key={item.finding.id} className={`validation-row ${item.status}`}>
                    <strong>{item.finding.id}</strong>
                    <span>{item.renderedComment || item.finding.comment_body}</span>
                    <em>{item.reason || item.status}</em>
                  </div>
                ))}
              </div>
            )}
            <div className="footer-actions">
              <button
                className="primary"
                disabled={!source || !packageResult || !commentOutputFolder || !validation?.ok || busy}
                onClick={createCommentedFile}
              >
                <FileCheck2 size={16} /> Create Commented File
              </button>
            </div>
            {commentResult && (
              <div className="result-panel">
                <h4>Created</h4>
                <p>{fileName(commentResult.outputPath)}</p>
                <div className="inline-actions">
                  <button className="secondary" onClick={() => window.hl.openPath(commentResult.outputPath)}><FolderOpen size={16} /> Open file</button>
                  <button className="secondary" onClick={() => window.hl.openPath(commentResult.reportPath)}><FileText size={16} /> Open report</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Preflight() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [outputFolder, setOutputFolder] = useState("");
  const [modeAll, setModeAll] = useState<ProcessingMode>("text-visual");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [forceVisualSupplement, setForceVisualSupplement] = useState(false);
  const [preserveExistingComments, setPreserveExistingComments] = useState(false);
  const [runLocalOcr, setRunLocalOcr] = useState(false);
  const [jobId, setJobId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    window.hl.getSettings().then((settings) => settings.lastOutputFolder && setOutputFolder(settings.lastOutputFolder));
  }, []);

  useEffect(() => {
    return window.hl.onProgress((event) => {
      setRows((current) =>
        current.map((row) =>
          row.metadata.path === event.filePath
            ? { ...row, status: event.message, progress: event.percent }
            : row
        )
      );
    });
  }, []);

  async function addFiles() {
    const selected = await window.hl.selectDocuments();
    appendRows(selected);
  }

  function appendRows(files: FileMetadata[]) {
    setRows((current) => {
      const known = new Set(current.map((row) => row.metadata.path));
      return [
        ...current,
        ...files
          .filter((file) => !known.has(file.path))
          .map((metadata) => ({
            id: crypto.randomUUID(),
            metadata,
            mode: modeAll,
            status: metadata.type === "pdf" ? "Ready" : "Not verified",
            progress: 0
          }))
      ];
    });
  }

  async function chooseOutput() {
    const folder = await window.hl.selectFolder();
    if (folder) {
      setOutputFolder(folder);
      await window.hl.saveSettings({ lastOutputFolder: folder });
    }
  }

  function applyModeToAll(mode: ProcessingMode) {
    setModeAll(mode);
    setRows((current) => current.map((row) => ({ ...row, mode })));
  }

  async function generateAll() {
    if (!rows.length || !outputFolder) return;
    const nextJobId = crypto.randomUUID();
    setJobId(nextJobId);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const results = await window.hl.generatePreflight({
        jobId: nextJobId,
        files: rows.map((row) => ({ path: row.metadata.path, mode: row.mode })),
        outputFolder,
        options: { forceVisualSupplement, preserveExistingComments, runLocalOcr }
      });
      setRows((current) =>
        current.map((row) => {
          const result = results.find((item) => item.sourcePath === row.metadata.path);
          return result
            ? { ...row, result, progress: result.status === "complete" ? 100 : row.progress, status: result.error ?? result.status }
            : row;
        })
      );
      const failures = results.filter((result) => result.status !== "complete");
      if (failures.length) setError(`${failures.length} file${failures.length === 1 ? "" : "s"} need attention.`);
      else setSuccess("Preflight files generated.");
    } catch (generateError) {
      setError(messageOf(generateError));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (jobId) await window.hl.cancelJob(jobId);
  }

  return (
    <div className="workspace">
      <section className="section-head">
        <div>
          <h2>LLM Preflight</h2>
          <p>Convert files into anchored Markdown and visual references without calling an LLM.</p>
        </div>
        <div className="inline-actions">
          <button className="secondary" onClick={addFiles}><Upload size={16} /> Browse files</button>
          <button className="ghost" onClick={() => setRows([])} disabled={!rows.length}><X size={16} /> Clear all</button>
        </div>
      </section>

      <Status error={error} success={success} />
      <GuidePanel
        title="Preflight guide"
        steps={[
          "Add one or more PDFs to the queue.",
          "Use Text + visual pages for most files; choose Text only only when visuals are not material.",
          "Set the output folder where each file should get its own result folder.",
          "Generate Preflight Files and wait for each row to finish.",
          "Give the Markdown and visual supplement, when created, to the approved LLM environment."
        ]}
      />
      <LoadingOverlay active={busy} label="Generating local files" />

      <section className="panel wide">
        <DropZone
          onFiles={async (paths) => {
            const metadata = await Promise.all(paths.map((filePath) => window.hl.getMetadata(filePath)));
            appendRows(metadata);
          }}
        >
          {rows.length ? (
            <div className="queue-table">
              <div className="queue-head">
                <span>Filename</span>
                <span>Type</span>
                <span>Size</span>
                <span>Count</span>
                <span>Processing mode</span>
                <span>Status</span>
                <span></span>
              </div>
              {rows.map((row) => (
                <div className="queue-row" key={row.id}>
                  <strong title={row.metadata.path}>{row.metadata.name}</strong>
                  <span>{row.metadata.type.toUpperCase()}</span>
                  <span>{formatBytes(row.metadata.sizeBytes)}</span>
                  <span>{row.metadata.countLabel || "-"}</span>
                  <select
                    value={row.mode}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((item) => (item.id === row.id ? { ...item, mode: event.target.value as ProcessingMode } : item))
                      )
                    }
                  >
                    {processingModes.map((mode) => (
                      <option key={mode.value} value={mode.value}>{mode.label}</option>
                    ))}
                  </select>
                  <span>
                    <Progress value={row.progress} label={row.status} />
                  </span>
                  <button className="icon-button" aria-label="Remove file" onClick={() => setRows(rows.filter((item) => item.id !== row.id))}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyDrop icon={<Upload />} label="Browse files or drop PDFs" onBrowse={addFiles} />
          )}
        </DropZone>
      </section>

      <section className="panel wide">
        <div className="toolbar-line">
          <Select
            label="Apply one processing mode to all files"
            value={modeAll}
            onChange={(value) => applyModeToAll(value as ProcessingMode)}
            options={processingModes.map((mode) => mode.value)}
            labels={Object.fromEntries(processingModes.map((mode) => [mode.value, mode.label]))}
          />
          <FolderField value={outputFolder} onBrowse={chooseOutput} />
        </div>
        <p className="warning-line">
          Text only mode omits visual supplements; charts, diagrams, images, and layout-dependent information may be omitted.
        </p>
        <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
          <summary>Advanced</summary>
          <div className="checkbox-grid compact-options">
            <label><input type="checkbox" checked={runLocalOcr} onChange={(event) => setRunLocalOcr(event.target.checked)} /> Run local OCR on scanned pages</label>
            <label><input type="checkbox" checked={preserveExistingComments} onChange={(event) => setPreserveExistingComments(event.target.checked)} /> Preserve existing comments in extracted text</label>
            <label><input type="checkbox" checked={forceVisualSupplement} onChange={(event) => setForceVisualSupplement(event.target.checked)} /> Force a visual supplement</label>
          </div>
        </details>
        <div className="footer-actions">
          <button className="primary" disabled={!rows.length || !outputFolder || busy} onClick={generateAll}>
            <RefreshCw size={16} /> Generate Preflight Files
          </button>
          <button className="secondary" disabled={!busy} onClick={cancel}>Cancel</button>
          <button className="secondary" disabled={!outputFolder} onClick={() => window.hl.openPath(outputFolder)}><FolderOpen size={16} /> Open resulting folder</button>
        </div>
      </section>
    </div>
  );
}

function Status({ error, success }: { error: string; success: string }) {
  if (!error && !success) return null;
  return (
    <div className={error ? "status error" : "status success"}>
      {error ? <AlertTriangle size={16} /> : <Check size={16} />}
      <span>{error || success}</span>
    </div>
  );
}

function GuidePanel({ title, steps }: { title: string; steps: string[] }) {
  return (
    <section className="guide-panel" aria-label={title}>
      <div>
        <strong>{title}</strong>
        <span>Simple path</span>
      </div>
      <ol>
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </section>
  );
}

function LoadingOverlay({ active, label }: { active: boolean; label: string }) {
  if (!active) return null;
  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <div className="loading-panel">
        <div className="loading-mark" aria-hidden="true" />
        <div>
          <strong>{label}</strong>
          <span>No documents are uploaded.</span>
        </div>
      </div>
    </div>
  );
}

function FileSummary({ file }: { file: FileMetadata }) {
  return (
    <div className="file-summary">
      <FileText size={20} />
      <div>
        <strong>{file.name}</strong>
        <span>{file.type.toUpperCase()} · {formatBytes(file.sizeBytes)} · {file.countLabel || "Count unavailable"}</span>
        {file.sha256 && <small>SHA-256 {file.sha256.slice(0, 16)}...</small>}
      </div>
    </div>
  );
}

function EmptyDrop({ icon, label, onBrowse }: { icon: ReactNode; label: string; onBrowse: () => void }) {
  return (
    <div className="empty-drop">
      {icon}
      <button className="secondary" onClick={onBrowse}>{label}</button>
    </div>
  );
}

function DropZone({ children, onFiles }: { children: ReactNode; onFiles: (paths: string[]) => void | Promise<void> }) {
  return (
    <div
      className="drop-zone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={async (event) => {
        event.preventDefault();
        const paths = Array.from(event.dataTransfer.files)
          .map((file) => window.hl.getDroppedFilePath(file))
          .filter(Boolean);
        if (paths.length) await onFiles(paths);
      }}
    >
      {children}
    </div>
  );
}

function FolderField({ value, onBrowse }: { value: string; onBrowse: () => void }) {
  return (
    <label className="folder-field">
      <span>Output folder</span>
      <div>
        <input className="input" value={value} readOnly placeholder="Select output folder" />
        <button className="secondary" onClick={onBrowse} type="button"><FolderOpen size={16} /> Browse</button>
      </div>
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  labels
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  labels?: Record<string, string>;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>{labels?.[option] ?? labelize(option)}</option>
        ))}
      </select>
    </label>
  );
}

function Summary({ validation }: { validation: ClaudeValidationResult | null }) {
  if (!validation) return <p className="muted">Validate the Claude result before creating the commented file.</p>;
  return (
    <div className="summary-grid">
      <div><strong>{validation.summary.valid}</strong><span>Valid comments</span></div>
      <div><strong>{validation.summary.attention}</strong><span>Require attention</span></div>
      <div><strong>{validation.summary.invalid}</strong><span>Invalid or skipped</span></div>
    </div>
  );
}

function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="progress-wrap">
      <div className="progress-bar"><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
      <small>{label}</small>
    </div>
  );
}

function renderPreview(template: string): string {
  const values: Record<string, string> = {
    comment: "Please confirm this percentage against the summary table.",
    value: "14.2%",
    page: "12",
    total_pages: "84",
    sheet: "Operating Model",
    cell: "F42",
    slide: "7",
    category: "numbers",
    severity: "medium",
    suggested_replacement: "14.1%"
  };
  return template.replace(/\{([a-z_]+)\}/g, (_, key: string) => values[key] ?? "").replace(/\s+/g, " ").trim();
}

function move<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return items;
  const copy = [...items];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function labelize(value: string): string {
  return value.replace(/-/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function extension(name: string): string {
  const match = name.match(/\.[^.]+$/);
  return match?.[0] ?? "";
}

function withoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

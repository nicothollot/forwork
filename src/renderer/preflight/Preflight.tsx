import { FolderOpen, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AppSettings,
  FileMetadata,
  PreflightFileResult,
  ProcessingMode,
  ProgressEvent
} from "../../shared/types";
import type { UpdateSettings } from "../hooks/useLocalPreferences";
import {
  AdvancedPanel,
  DropZone,
  EmptyDrop,
  ErrorBanner,
  FileCard,
  FolderField,
  LoadingOverlay,
  PageHeader,
  Progress,
  SelectField,
  StatusBanner
} from "../components/common";
import { userError, type UserFacingError } from "../lib/errors";
import { countKind, displayDocumentType, fileName, formatBytes, modeLabel } from "../lib/format";

interface QueueRow {
  id: string;
  metadata: FileMetadata;
  recommendedMode: ProcessingMode;
  mode: ProcessingMode;
  status: string;
  progress: number;
  result?: PreflightFileResult;
}

const modeOptions: ProcessingMode[] = ["text-only", "text-visual", "text-all-pages"];

export function Preflight({
  settings,
  updateSettings,
  loaded
}: {
  settings: AppSettings;
  updateSettings: UpdateSettings;
  loaded: boolean;
}) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [outputFolder, setOutputFolder] = useState("");
  const [bulkMode, setBulkMode] = useState<ProcessingMode>("text-visual");
  const [forceVisualSupplement, setForceVisualSupplement] = useState(false);
  const [preserveExistingComments, setPreserveExistingComments] = useState(false);
  const [jobId, setJobId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserFacingError | null>(null);
  const [success, setSuccess] = useState("");
  const hasUnsupportedRows = rows.some((row) => row.metadata.supportStatus !== "verified");

  useEffect(() => {
    if (loaded) setOutputFolder(settings.lastOutputFolder ?? "");
  }, [loaded]);

  useEffect(() => {
    return window.hl.onProgress((event: ProgressEvent) => {
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
          .map((metadata) => {
            const recommendedMode = recommendedModeFor(metadata);
            return {
              id: crypto.randomUUID(),
              metadata,
              recommendedMode,
              mode: recommendedMode,
              status: metadata.supportStatus === "verified" ? "Ready" : metadata.supportMessage || "Not supported",
              progress: 0
            } satisfies QueueRow;
          })
      ];
    });
  }

  async function chooseOutput() {
    const folder = await window.hl.selectFolder();
    if (folder) {
      setOutputFolder(folder);
      updateSettings({ lastOutputFolder: folder });
    }
  }

  function applyModeToAll(mode: ProcessingMode) {
    setBulkMode(mode);
    setRows((current) => current.map((row) => ({ ...row, mode })));
  }

  async function generateAll() {
    if (!rows.length || !outputFolder) return;
    const nextJobId = crypto.randomUUID();
    setJobId(nextJobId);
    setBusy(true);
    setError(null);
    setSuccess("");
    try {
      const results = await window.hl.generatePreflight({
        jobId: nextJobId,
        files: rows.map((row) => ({ path: row.metadata.path, mode: row.mode })),
        outputFolder,
        options: { forceVisualSupplement, preserveExistingComments }
      });
      setRows((current) =>
        current.map((row) => {
          const result = results.find((item) => item.sourcePath === row.metadata.path);
          if (!result) return row;
          return {
            ...row,
            result,
            progress: result.status === "complete" ? 100 : row.progress,
            status: result.status === "complete" ? "Complete" : result.status === "cancelled" ? "Cancelled" : "Needs attention"
          };
        })
      );
      const failures = results.filter((result) => result.status !== "complete");
      if (failures.length) {
        setError({
          title: "Preflight generation finished with files needing attention.",
          file: failures.length === 1 ? fileName(failures[0].sourcePath) : `${failures.length} files`,
          sourceChanged: "No",
          nextStep: "Show details, fix or remove the affected file, then generate again.",
          details: failures.map((failure) => `${fileName(failure.sourcePath)}: ${failure.error || failure.status}`).join("\n")
        });
      } else {
        setSuccess("Preflight files generated.");
      }
    } catch (generateError) {
      setError(
        userError({
          action: "Preflight generation failed.",
          error: generateError,
          nextStep: "Show details, confirm each file is accessible and the output folder is writable, then try again."
        })
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (jobId) await window.hl.cancelJob(jobId);
  }

  return (
    <div className="workspace">
      <PageHeader
        title="LLM Preflight"
        description="Generate anchored Markdown and local visual supplements without calling an LLM."
        actions={
          <>
            <button className="secondary" onClick={addFiles}>
              <Upload size={16} /> Browse files
            </button>
            <button className="ghost" onClick={() => setRows([])} disabled={!rows.length}>
              <X size={16} /> Clear all
            </button>
          </>
        }
      />

      <ErrorBanner error={error} />
      <StatusBanner success={success} />
      <LoadingOverlay active={busy} label="Generating local files" />

      <div className="flow-stack">
        <section className="panel">
          <DropZone
            label="Preflight files drop zone"
            onFiles={async (paths) => {
              const metadata = await Promise.all(paths.map((filePath) => window.hl.getMetadata(filePath)));
              appendRows(metadata);
            }}
          >
            {rows.length ? (
              <div className="preflight-list" aria-label="Preflight queue">
                {rows.map((row) => (
                  <PreflightCard
                    key={row.id}
                    row={row}
                    onModeChange={(mode) =>
                      setRows((current) => current.map((item) => (item.id === row.id ? { ...item, mode } : item)))
                    }
                    onRemove={() => setRows((current) => current.filter((item) => item.id !== row.id))}
                  />
                ))}
              </div>
            ) : (
              <EmptyDrop label="Browse or drop files" onBrowse={addFiles} />
            )}
          </DropZone>
        </section>

        <section className="panel">
          <div className="generate-grid">
            <FolderField value={outputFolder} onBrowse={chooseOutput} />
            <div className="footer-actions no-margin">
              <button className="primary" disabled={!rows.length || hasUnsupportedRows || !outputFolder || busy} onClick={generateAll}>
                <RefreshCw size={16} /> Generate
              </button>
              <button className="secondary" disabled={!busy} onClick={cancel}>
                Cancel
              </button>
              <button className="secondary" disabled={!outputFolder} onClick={() => window.hl.openPath(outputFolder)}>
                <FolderOpen size={16} /> Open folder
              </button>
            </div>
          </div>
          <AdvancedPanel>
            <div className="advanced-grid">
              <section>
                <h4>Format-specific options</h4>
                <div className="checkbox-grid compact-options">
                  <label>
                    <input
                      type="checkbox"
                      checked={preserveExistingComments}
                      onChange={(event) => setPreserveExistingComments(event.target.checked)}
                    />
                    Include existing comments when supported
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={forceVisualSupplement}
                      onChange={(event) => setForceVisualSupplement(event.target.checked)}
                    />
                    Force visual supplement when supported
                  </label>
                </div>
              </section>
              <section>
                <h4>Selected mode for all files</h4>
                <SelectField
                  label="Mode"
                  value={bulkMode}
                  onChange={(value) => applyModeToAll(value as ProcessingMode)}
                  options={modeOptions.map((mode) => ({ value: mode, label: modeLabel(mode) }))}
                />
              </section>
            </div>
          </AdvancedPanel>
        </section>
      </div>
    </div>
  );
}

function PreflightCard({
  row,
  onModeChange,
  onRemove
}: {
  row: QueueRow;
  onModeChange: (mode: ProcessingMode) => void;
  onRemove: () => void;
}) {
  const result = row.result;
  return (
    <article className="preflight-card">
      <div className="preflight-file">
        <FileCard
          file={row.metadata}
          action={
            <button className="icon-button" aria-label={`Remove ${row.metadata.name}`} onClick={onRemove}>
              <Trash2 size={15} />
            </button>
          }
        />
      </div>
      <div className="preflight-fields">
        <Metric label="Type" value={displayDocumentType(row.metadata.type)} />
        <Metric label="Size" value={formatBytes(row.metadata.sizeBytes)} />
        <Metric label={countKind(row.metadata)} value={row.metadata.countLabel || "-"} />
        <Metric label="Recommended mode" value={`${modeLabel(row.recommendedMode, row.metadata.type)} - Recommended`} />
        <label className="field">
          <span>Selected mode</span>
          <select value={row.mode} onChange={(event) => onModeChange(event.target.value as ProcessingMode)}>
            {modeOptions.map((mode) => (
              <option key={mode} value={mode}>
                {modeLabel(mode, row.metadata.type)}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className="metric-label">Progress</span>
          <Progress value={row.progress} label={row.status} />
        </div>
        <Metric label="Status" value={result?.status === "complete" ? "Complete" : row.status} />
      </div>
      {result?.summary ? <PreflightResultSummary result={result} /> : null}
      {result?.status === "complete" ? (
        <div className="footer-actions compact">
          <button className="secondary" onClick={() => window.hl.openPath(result.outputFolder)}>
            <FolderOpen size={16} /> Open folder
          </button>
        </div>
      ) : null}
    </article>
  );
}

function PreflightResultSummary({ result }: { result: PreflightFileResult }) {
  const summary = result.summary;
  if (!summary) return null;
  return (
    <dl className="result-summary">
      <MetricTerm label="Original size" value={formatBytes(summary.originalSizeBytes)} />
      <MetricTerm label="Markdown size" value={formatBytes(summary.markdownSizeBytes)} />
      <MetricTerm label="Visual supplement size" value={formatBytes(summary.visualSupplementSizeBytes)} />
      <MetricTerm label="Approx. token estimate" value={String(summary.approximateTokenEstimate)} />
      <MetricTerm
        label="Approx. reduction"
        value={summary.approximateReductionPercent === null ? "Unavailable" : `${summary.approximateReductionPercent}%`}
      />
      <MetricTerm label="Visual pages/slides" value={String(summary.visualPageCount)} />
      <MetricTerm label="Warning count" value={String(summary.warningCount)} />
    </dl>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MetricTerm({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function recommendedModeFor(_metadata: FileMetadata): ProcessingMode {
  return "text-visual";
}

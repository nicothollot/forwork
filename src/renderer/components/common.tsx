import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Upload
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { FileMetadata } from "../../shared/types";
import type { UserFacingError } from "../lib/errors";
import { displayDocumentType, formatBytes } from "../lib/format";

export function PageHeader({
  title,
  description,
  actions
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <section className="section-head">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions ? <div className="inline-actions">{actions}</div> : null}
    </section>
  );
}

export function StatusBanner({ success }: { success?: string }) {
  if (!success) return null;
  return (
    <div className="status success" role="status" aria-live="polite">
      <Check size={16} />
      <span>{success}</span>
    </div>
  );
}

export function ErrorBanner({ error }: { error: UserFacingError | null }) {
  const [open, setOpen] = useState(false);
  if (!error) return null;
  return (
    <div className="status error" role="alert" aria-live="assertive">
      <AlertTriangle size={16} />
      <div className="error-copy">
        <strong>{error.title}</strong>
        <span>{error.file ? `File: ${error.file}. ` : ""}Source changed: {error.sourceChanged}. {error.nextStep}</span>
        {error.details ? (
          <>
            <button className="text-button" type="button" onClick={() => setOpen((value) => !value)}>
              {open ? "Hide details" : "Show details"}
            </button>
            {open ? <pre>{error.details}</pre> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function LoadingOverlay({ active, label }: { active: boolean; label: string }) {
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

export function DropZone({
  children,
  onFiles,
  label = "File drop zone"
}: {
  children: ReactNode;
  onFiles: (paths: string[]) => void | Promise<void>;
  label?: string;
}) {
  return (
    <div
      className="drop-zone"
      aria-label={label}
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

export function EmptyDrop({ label, onBrowse }: { label: string; onBrowse: () => void }) {
  return (
    <div className="empty-drop">
      <Upload size={22} aria-hidden="true" />
      <button className="secondary" type="button" onClick={onBrowse}>
        {label}
      </button>
    </div>
  );
}

export function FileCard({ file, action }: { file: FileMetadata; action?: ReactNode }) {
  return (
    <div className="file-card">
      <FileText size={20} aria-hidden="true" />
      <div>
        <strong title={file.path}>{file.name}</strong>
        <span>
          {displayDocumentType(file.type)} · {formatBytes(file.sizeBytes)} · {file.countLabel || "Count unavailable"}
        </span>
        {file.sha256 ? <small>SHA-256 {file.sha256.slice(0, 16)}...</small> : null}
      </div>
      {action ? <div className="file-card-action">{action}</div> : null}
    </div>
  );
}

export function FolderField({
  value,
  onBrowse,
  label = "Output folder"
}: {
  value: string;
  onBrowse: () => void;
  label?: string;
}) {
  return (
    <label className="folder-field">
      <span>{label}</span>
      <div>
        <input className="input" value={value} readOnly placeholder="Select output folder" />
        <button className="secondary" onClick={onBrowse} type="button">
          <FolderOpen size={16} /> Browse
        </button>
      </div>
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AdvancedPanel({ title = "Advanced", children }: { title?: string; children: ReactNode }) {
  return (
    <details className="advanced-panel">
      <summary>
        <ChevronRight className="summary-closed" size={15} />
        <ChevronDown className="summary-open" size={15} />
        {title}
      </summary>
      <div className="advanced-body">{children}</div>
    </details>
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="progress-wrap">
      <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <small>{label}</small>
    </div>
  );
}

export function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="field-group">
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}

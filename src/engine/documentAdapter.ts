import type {
  CommentOutputResult,
  CreateCommentedPdfInput,
  DocumentInspection,
  DocumentType,
  FindingValidation,
  LocalReviewJob,
  OutputVerification,
  PreparedDocument,
  PrepareReviewInput,
  ProcessingMode,
  ProgressEvent,
  ReviewFinding,
  ReviewPackageResult
} from "../shared/types.js";

export interface DocumentInspectInput {
  sourcePath: string;
  includeHash?: boolean;
}

export interface PrepareDocumentInput {
  sourcePath: string;
  mode: ProcessingMode;
  sourceHash: string;
  outputFolder?: string;
  outputBaseName?: string;
  forceVisualSupplement?: boolean;
  preserveExistingComments?: boolean;
  createdAt?: string;
  progress?: (stage: ProgressEvent["stage"], percent: number, message: string) => void;
  isCancelled?: () => boolean;
}

export interface ValidateFindingInput {
  localJob: LocalReviewJob;
  finding: ReviewFinding;
}

export interface VerifyOutputInput {
  outputPath: string;
  localJob: LocalReviewJob;
}

export interface DocumentAdapter {
  readonly documentTypes: readonly DocumentType[];
  inspect(input: DocumentInspectInput): Promise<DocumentInspection>;
  prepareDocument(input: PrepareDocumentInput): Promise<PreparedDocument>;
  createReviewPackage(input: PrepareReviewInput): Promise<ReviewPackageResult>;
  validateFinding(input: ValidateFindingInput): FindingValidation | Promise<FindingValidation>;
  applyComments(input: CreateCommentedPdfInput): Promise<CommentOutputResult>;
  verifyOutput(input: VerifyOutputInput): Promise<OutputVerification>;
}

export class DocumentAdapterRegistry {
  private readonly adapters = new Map<DocumentType, DocumentAdapter>();

  register(adapter: DocumentAdapter): void {
    for (const documentType of adapter.documentTypes) {
      if (this.adapters.has(documentType)) {
        throw new Error(`Document adapter already registered for ${documentType}.`);
      }
      this.adapters.set(documentType, adapter);
    }
  }

  get(documentType: DocumentType): DocumentAdapter | undefined {
    return this.adapters.get(documentType);
  }

  require(documentType: DocumentType): DocumentAdapter {
    const adapter = this.get(documentType);
    if (!adapter) {
      throw new Error(`${documentType.toUpperCase()} support is planned but not yet verified in this build.`);
    }
    return adapter;
  }

  registeredDocumentTypes(): DocumentType[] {
    return [...this.adapters.keys()];
  }
}

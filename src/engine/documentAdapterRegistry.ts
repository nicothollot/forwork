import { DocumentAdapterRegistry } from "./documentAdapter.js";
import { excelDocumentAdapter } from "./excelDocumentAdapter.js";
import { pdfDocumentAdapter } from "./pdfDocumentAdapter.js";
import { powerPointDocumentAdapter } from "./powerPointDocumentAdapter.js";
import { wordDocumentAdapter } from "./wordDocumentAdapter.js";

export const documentAdapterRegistry = new DocumentAdapterRegistry();
documentAdapterRegistry.register(pdfDocumentAdapter);
documentAdapterRegistry.register(wordDocumentAdapter);
documentAdapterRegistry.register(excelDocumentAdapter);
documentAdapterRegistry.register(powerPointDocumentAdapter);

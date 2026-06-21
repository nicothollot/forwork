# Document Support

Only formats with passing extraction and output tests are marked verified.

| Format | Preflight text extraction | Visual supplement | Stable anchors | Native comment output | Known limitations | Test status |
| --- | --- | --- | --- | --- | --- | --- |
| PDF | Verified | Verified for selected or all pages | Verified block and page anchors | Verified text annotations and evidence highlights | Table extraction is line/block based in this MVP; OCR is not implemented | Passing synthetic tests |
| DOCX | Planned | Planned when reliable local renderer exists | Planned paragraph/table-cell anchors | Planned Word comments | Not enabled until fidelity tests pass | Not supported |
| XLSX | Planned | Planned for charts/dashboard sheets when renderer exists | Planned cell/range anchors | Planned comments/notes | Macros are never executed; macro preservation needs explicit tests | Not supported |
| PPTX | Planned | Planned slide rendering when reliable local renderer exists | Planned slide/shape anchors | Sidecar first unless native comment round-trip is verified | Native comments are not enabled | Not supported |

Unsupported Office files may be selected but are reported as not verified. HL Intelligence does not silently claim support.

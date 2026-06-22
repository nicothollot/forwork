import type { OfficeProbeResponse, OfficeWorkerClientOptions } from "./officeTypes.js";
import { runOfficeWorker } from "./officeWorkerClient.js";

export async function probeOfficeCapabilities(options: OfficeWorkerClientOptions = {}): Promise<OfficeProbeResponse> {
  try {
    return await runOfficeWorker<OfficeProbeResponse>(
      {
        schema_version: "1.0",
        operation: "probe"
      },
      options
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Office capability probe could not run.";
    return {
      schema_version: "1.0",
      operation: "probe",
      ok: false,
      applications: {
        word: { available: false, message },
        excel: { available: false, message },
        powerpoint: { available: false, message }
      },
      worker: {
        platform: process.platform,
        powerShell: "unavailable"
      }
    };
  }
}
